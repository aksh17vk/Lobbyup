import { PrismaClient } from '@prisma/client';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

/**
 * Least-privilege database access.
 *
 * Two identities:
 *  - the OWNER / migrator (DIRECT_DATABASE_URL): owns the schema and runs `prisma migrate deploy`;
 *  - the APP role (DATABASE_URL): what the running API uses. It may only read and write rows:
 *      SELECT/INSERT/UPDATE/DELETE on application tables, sequences for ids,
 *      NO DDL (cannot create/alter/drop anything), NO TRUNCATE,
 *      audit_logs is append-only (also enforced by a trigger, see migrations),
 *      no access to Prisma's migration history.
 *
 * Works for owners that are not superusers (Neon, Supabase, RDS, Cloud SQL): it never names role
 * attributes the caller may lack, and instead VERIFIES the resulting privileges, failing loudly if
 * the role can do more than intended. Idempotent: run after every migration (`pnpm db:roles`).
 *
 * The plaintext password never reaches the database server: only a SCRAM-SHA-256 verifier is sent
 * (the same thing psql's \password does), so it cannot leak through server logs.
 */
export async function provisionAppRole(ownerUrl: string, appUser: string, appPassword: string) {
  if (!/^[a-z_][a-z0-9_]{2,62}$/.test(appUser)) {
    throw new Error('APP_DB_USER must be 3–63 chars of lowercase letters, digits and underscores');
  }
  if (appPassword.length < 16) throw new Error('APP_DB_PASSWORD must be at least 16 characters');
  if (!/^[\x21-\x7e]+$/.test(appPassword)) {
    throw new Error('APP_DB_PASSWORD must be printable ASCII without spaces');
  }

  const owner = new PrismaClient({ datasourceUrl: ownerUrl });
  try {
    const [me] = await owner.$queryRaw<{ current_user: string }[]>`SELECT current_user`;
    if (me?.current_user === appUser) throw new Error('The app role must differ from the migration owner');

    const [tables] = await owner.$queryRaw<{ audit: boolean; migrations: boolean }[]>`
      SELECT to_regclass('public.audit_logs') IS NOT NULL AS audit,
             to_regclass('public._prisma_migrations') IS NOT NULL AS migrations`;
    if (!tables?.audit || !tables.migrations) {
      throw new Error('Run `prisma migrate deploy` before `pnpm db:roles` (application tables not found)');
    }

    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('lobbyup.app_user', ${appUser}, true),
                                  set_config('lobbyup.app_pw', ${scramVerifier(appPassword)}, true)`;
      await tx.$executeRaw`
        DO $$
        DECLARE
          u text := current_setting('lobbyup.app_user');
          v text := current_setting('lobbyup.app_pw');
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = u) THEN
            -- New roles default to NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS.
            EXECUTE format('CREATE ROLE %I LOGIN', u);
          END IF;
          EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', u, v);
          EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), u);
          -- PostgreSQL <= 14 (and clusters upgraded from it) let PUBLIC create in schema public.
          BEGIN
            EXECUTE 'REVOKE CREATE ON SCHEMA public FROM PUBLIC';
          EXCEPTION WHEN insufficient_privilege THEN
            RAISE NOTICE 'not the owner of schema public; relying on the verification below';
          END;
          EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', u);
          EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', u);
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', u);
          EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM %I', u);
          EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', u);
          -- Tables created by future migrations (run as this owner) get the same row-level grants.
          EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', u);
          EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', u);
          EXECUTE format('REVOKE UPDATE, DELETE ON audit_logs FROM %I', u);
          EXECUTE format('REVOKE ALL ON _prisma_migrations FROM %I', u);
        END $$`;
    });

    const problems = await verifyAppRole(owner, appUser);
    if (problems.length) {
      throw new Error(`App role "${appUser}" has more privileges than intended:\n  - ${problems.join('\n  - ')}`);
    }
  } finally {
    await owner.$disconnect();
  }
}

/** Effective-privilege check (independent of how the grants got there). Empty = OK. */
export async function verifyAppRole(db: PrismaClient, appUser: string): Promise<string[]> {
  const [r] = await db.$queryRaw<
    {
      super: boolean;
      createrole: boolean;
      createdb: boolean;
      replication: boolean;
      bypassrls: boolean;
      member_of: string[];
      schema_create: boolean;
      audit_update: boolean;
      audit_delete: boolean;
      migrations_select: boolean;
    }[]
  >`
    SELECT r.rolsuper AS super, r.rolcreaterole AS createrole, r.rolcreatedb AS createdb,
           r.rolreplication AS replication, r.rolbypassrls AS bypassrls,
           ARRAY(SELECT g.rolname::text FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                  WHERE m.member = r.oid) AS member_of,
           has_schema_privilege(r.rolname, 'public', 'CREATE') AS schema_create,
           has_table_privilege(r.rolname, 'public.audit_logs', 'UPDATE') AS audit_update,
           has_table_privilege(r.rolname, 'public.audit_logs', 'DELETE') AS audit_delete,
           has_table_privilege(r.rolname, 'public._prisma_migrations', 'SELECT') AS migrations_select
      FROM pg_roles r WHERE r.rolname = ${appUser}`;
  if (!r) return [`role ${appUser} does not exist`];
  const out: string[] = [];
  if (r.super) out.push('is a superuser');
  if (r.createrole) out.push('can create roles');
  if (r.createdb) out.push('can create databases');
  if (r.replication) out.push('has REPLICATION');
  if (r.bypassrls) out.push('bypasses row-level security');
  if (r.member_of.length) out.push(`inherits from other roles: ${r.member_of.join(', ')}`);
  if (r.schema_create) out.push('can CREATE objects in schema public');
  if (r.audit_update || r.audit_delete) out.push('can modify or delete audit_logs');
  if (r.migrations_select) out.push('can read _prisma_migrations');
  return out;
}

/** SCRAM-SHA-256 password verifier, as stored in pg_authid (RFC 5802 / RFC 7677). */
export function scramVerifier(password: string, iterations = 4096): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}
