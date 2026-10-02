# Database, RBAC & security

PostgreSQL is the only source of truth. Redis holds caches, rate-limit counters and a short-lived answer buffer, and is never the only copy of anything durable. The schema lives in [`prisma/schema.prisma`](../prisma/schema.prisma), and the SQL for each change is in [`prisma/migrations/`](../prisma/migrations).

## 1. Entity map

Some columns use a different name, or a broader design, than the PRD:

| PRD | Table / column | Notes |
|---|---|---|
| User (`name`, `student_id`, `email`, `status`) | `users` (`full_name`, `student_id`, `email`, `status`, `password_hash`) | `email` unique. `student_id` is unique when present (staff have none). Failed-login counter and lock time sit alongside. |
| Role, Permission, UserRole, RolePermission | `roles`, `permissions` (`key` = name), `user_roles`, `role_permissions` | Composite primary keys on the join tables. |
| Quiz (`randomize_*`, `total_marks`, `passing_marks`) | `quizzes` (`shuffle_questions`, `shuffle_options`, `total_marks`, `passing_marks`, `passing_percentage`) | `total_marks` is computed by the server at publish and is never accepted from a client. |
| Question (`question_text`, `marks`, `order_no`) | `questions` (`prompt`, `points`, `negative_points`, `position`, `pool_id`) | Optional question pools in `question_pools`. |
| Option | `question_options` | `is_correct` never appears in student responses (tested). |
| Attempt (`score`) | `attempts` (`score`, `started_at`, `expires_at`, `submitted_at`, …) | Also stores the violation score and review status. |
| AttemptQuestion (`display_order`) | `attempt_questions` (`display_order`, `option_order[]`) | Primary key is (`attempt_id`, `question_id`). It also fixes option order per attempt. |
| Answer (`selected_option_id`) | `answers` (`response` jsonb, `revision`, `client_saved_at`, `server_saved_at`) | **`UNIQUE(attempt_id, question_id)`**. `response` is `{selectedOptionIds: [...]}` or `{text}`, so multiple-choice and short-text answers fit too. Option ids are validated against the attempt's own options on every write. |
| Result | `results` | `UNIQUE(attempt_id)` is the backstop against a duplicate result. |
| ExamEvent | `exam_events` (`type`, `client_timestamp`, `server_timestamp`, `metadata`, `weight`) | `UNIQUE(attempt_id, client_event_id)` makes ingestion idempotent. |
| Session (`attempt_id`, `device_metadata`, …) | `sessions` (login) and `exam_sessions` (per attempt, with `device_info`, `last_activity_at`, `expires_at`, `status`) | One `ACTIVE` exam session per attempt, enforced by a partial unique index. |

### Indexes
Only indexes that serve real queries are created, because every index adds write cost on hot tables.

| Index | Serves |
|---|---|
| `users(email)` unique, `users(student_id)` unique | login, admin search |
| `attempts(quiz_id, user_id, attempt_number)` unique, `attempts(user_id, status)`, `attempts(quiz_id, status)`, `attempts(status, expires_at)` | ownership lookups, quiz dashboards, the expiry sweep |
| **partial** unique `attempts(quiz_id, user_id) WHERE status IN (IN_PROGRESS, SUBMITTING)` | at most one live attempt per student per quiz |
| `answers(attempt_id, question_id)` unique, `answers(question_id)` | autosave upsert, per-question statistics |
| `exam_events(attempt_id, client_event_id)` unique, `exam_events(attempt_id, server_timestamp)`, `exam_events(type)` | idempotent ingest, an attempt's timeline, violation reports |
| **partial** unique `exam_sessions(attempt_id) WHERE status = 'ACTIVE'` | one controlled exam session |

### Foreign keys and cascades
- `quizzes → questions → question_options`: **CASCADE**. Content can only be deleted while the quiz is still a DRAFT with no attempts.
- `attempts → answers / attempt_questions / results / exam_events / exam_sessions`: **CASCADE**.
- `users → attempts` and `quizzes → attempts`: **RESTRICT**, so exam records can't be deleted by accident. Accounts are deactivated (`status`) rather than deleted.
- `answers(attempt_id, question_id) → attempt_questions`: a composite FK, so a stored answer must belong to a question in that attempt.

### CHECK constraints
- `expires_at > started_at`.
- Positive durations and attempt limits.
- A quiz's end time comes after its start time.
- Non-negative points and marks.
- `0 ≤ percentage ≤ 100`.
- Pool draw count of at least 1.
- Non-negative answer revisions.
- A non-blank `student_id`.

## 2. RBAC enforcement

Every request goes through these checks, in order:

1. **Authentication**: hashed opaque session token.
2. **Identity**: built from server state only.
3. **Role**.
4. **Permission**.
5. **Resource ownership**: another student's attempt returns `404`.
6. **Resource state**: lifecycle and deadline.

User id, role, permissions, score, marks, `expires_at`, attempt owner and submission status are always computed or read by the server. Request schemas are strict, so a body carrying `score`, `userId`, `role`, `totalMarks` and so on is rejected with `400`.

Submission is one transaction: `SELECT … FOR UPDATE` on the attempt, then validate the state and deadline, grade, insert the result, and update the attempt (`status`, `submitted_at`, `score`). A Postgres `lock_timeout` makes a duplicate finaliser fail fast with a retryable `503`.

## 3. Least-privilege access

| Identity | Used by | Rights |
|---|---|---|
| **Owner / migrator** (`DIRECT_DATABASE_URL`) | `prisma migrate deploy`, `pnpm db:roles`, backups | Owns the schema |
| **App role** (`DATABASE_URL`, default `lobbyup_app`) | The running API and workers | `SELECT/INSERT/UPDATE/DELETE` on application tables only. **No DDL, no TRUNCATE.** `audit_logs` is append-only. No access to `_prisma_migrations`. |

Set up the app role like this:
```bash
DIRECT_DATABASE_URL=postgresql://owner:***@host/db?sslmode=require \
APP_DB_USER=lobbyup_app APP_DB_PASSWORD='<long random secret>' \
pnpm db:roles          # idempotent: re-run after every migration
```
Notes on `pnpm db:roles`:
- It **must run after migrations**: it refuses to run if the application tables don't exist yet.
- It works when the owner is **not** a superuser (Neon, Supabase, RDS, Cloud SQL). It never sets role attributes the owner may lack. Instead it **checks the effective privileges** afterwards and fails if the app role is a superuser, can create roles or databases, inherits other roles, can create objects in `public`, can modify `audit_logs`, or can read `_prisma_migrations`.
- The password never reaches the database server in plaintext. Only a SCRAM-SHA-256 verifier is sent, the same thing psql's `\password` does, so it can't leak through server logs.
- `audit_logs` is also protected by a trigger that rejects `UPDATE`, `DELETE` and `TRUNCATE` from anyone except the table owner. That holds even if the grants are misconfigured.

Then run the API with `DATABASE_URL=postgresql://lobbyup_app:***@host/db?sslmode=require&connection_limit=10` and the Docker image with `MIGRATE_ON_BOOT=false`. Run migrations as a separate release step, so the API never holds the owner's credentials.

The whole automated test suite runs as such a restricted role. `tests/security/database.test.ts` checks that DDL, TRUNCATE, audit-log tampering and reading the migration history are all refused.

> Managed providers: Supabase lets the `postgres` role create roles. On Neon, create the role in the console or API if `CREATE ROLE` is refused, then run `pnpm db:roles` to apply the grants.

## 4. Connections, TLS and credentials
- **TLS:** use `?sslmode=require` (or `verify-full`) for any remote database, and `rediss://` for remote Redis. In production the API logs a warning at startup for a remote URL without TLS. A database on the same host or Docker network is exempt.
- **Pooling:** Prisma's pool size is set with `connection_limit` in `DATABASE_URL`. With Neon or Supabase, use the provider's transaction pooler URL plus `pgbouncer=true`, and keep `connection_limit` at or below the pooler's per-client limit. Interactive transactions set `maxWait`/`timeout`, and overload maps to `503`, never `500`.
- **Strong credentials:** with `NODE_ENV=production` the API **refuses to start** if `COOKIE_SECURE` is false, or if `DATABASE_URL` uses the public docker-compose credentials (`lobbyup:lobbyup`). The only exception is `ALLOW_DEV_CREDENTIALS=true`, which is for local load tests.
- **Parameterized queries:** all SQL goes through Prisma or tagged-template `$queryRaw`/`$executeRaw`, which send values as bind parameters. No application code builds SQL from strings. The app-role script passes the password as a bind parameter too.

### Secrets
`DATABASE_URL`, `DIRECT_DATABASE_URL`, `REDIS_URL`, `APP_DB_PASSWORD`, seed passwords and any backup keys come only from the environment or the platform's secret store.
- `.env`, dumps (`backups/`, `*.dump*`) and build output are git-ignored. Only `.env.example`, with placeholders, is committed.
- Logs redact authorization headers, cookies, passwords and tokens.
- No JWT secret exists: sessions are opaque random tokens stored as SHA-256 hashes, so a database leak doesn't expose usable tokens.

## 5. Migration strategy
- **Tooling:** Prisma Migrate. Every change is a committed SQL migration in `prisma/migrations/`, reviewed like code. Hand-written SQL (partial indexes, CHECKs, backfills) is appended to the generated file.
- **Never edit an applied migration.** Fix forward with a new one.
- **Expand → migrate → contract** for zero-downtime changes:
  1. Add the new nullable column or table, and deploy code that writes both the old and new shape.
  2. Backfill.
  3. Switch reads over.
  4. Drop the old shape in a later release.
- **Deploying:**
  1. Back up (§6).
  2. Run `prisma migrate deploy` with the owner URL.
  3. Run `pnpm db:roles`.
  4. Roll out the API.

  On a single instance, `MIGRATE_ON_BOOT=true` (the image default) runs step 2 on boot instead.
- **Rehearse** each release's migrations on a restored copy of production (§6) before the exam season. Don't migrate during an exam window.

## 6. Backup & restore strategy

| Layer | What | How often |
|---|---|---|
| Provider | Managed point-in-time recovery or snapshots (Neon or Supabase paid tiers; the free tiers keep only a short history) | continuous or daily |
| Logical | `scripts/backup-db.sh`: `pg_dump` custom format, archive verified, **GPG-encrypted** when `BACKUP_GPG_RECIPIENT` is set, SHA-256 checksum, pruned after `BACKUP_RETENTION_DAYS` (default 14) | nightly, plus before every migration and right after each exam |
| Off-site | Copy the encrypted dumps to separate storage (another provider or bucket). Don't leave the only copy on the database host, and never put dumps in git or public CI artifacts. | with each backup |

```bash
# Backup (Linux host with the PostgreSQL client installed; schedule via cron or a systemd timer)
BACKUP_DATABASE_URL=postgresql://owner:***@host/db?sslmode=require \
BACKUP_DIR=/var/backups/lobbyup BACKUP_GPG_RECIPIENT=ops@example.edu pnpm db:backup

# Restore into a NEW, EMPTY database, verify it, then switch the app over (rollback-safe)
createdb lobbyup_restored     # or create it in the provider console
RESTORE_DATABASE_URL=postgresql://owner:***@host/lobbyup_restored CONFIRM_RESTORE=yes \
pnpm db:restore /var/backups/lobbyup/lobbyup-<stamp>.dump.gpg
DIRECT_DATABASE_URL=postgresql://owner:***@host/lobbyup_restored APP_DB_PASSWORD=*** pnpm db:roles
# then point DATABASE_URL / DIRECT_DATABASE_URL at lobbyup_restored
```
Restore behaviour:
- It runs in a **single transaction** (all or nothing).
- It refuses to run without `CONFIRM_RESTORE=yes`, and refuses a target that already has tables. Restoring into a fresh database is what makes rolling back to a pre-migration backup safe even when the live schema is newer.
- Both scripts delete any partial or decrypted plaintext dump if they fail.
- Pass credentials through `PGPASSWORD` or `~/.pgpass` (with a password-less URL), so the password doesn't show up in `ps`.

Both scripts were tested against this project's Postgres 16, including the encrypted path:
- 509 users, 501 attempts, 16,765 answers and 501 results restored with identical counts.
- The checksum verified.
- The decrypted temporary file was removed afterwards.

**Restore drill:** at least once a term, restore the latest backup into a scratch database and run `loadtest/verify-loadtest.ts`, or compare row counts. A backup that has never been restored doesn't count.

With docker-compose, the same scripts run inside the `postgres` container, or with
`docker compose exec -T postgres pg_dump -U <owner> -Fc <db> > backup.dump` (encrypt it before it leaves the host).
