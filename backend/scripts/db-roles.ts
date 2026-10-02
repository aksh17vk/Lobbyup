/**
 * Create/update the least-privilege application database role.
 *
 *   DIRECT_DATABASE_URL=<owner url> APP_DB_USER=lobbyup_app APP_DB_PASSWORD=<strong secret> pnpm db:roles
 *
 * Then run the API with DATABASE_URL pointing at APP_DB_USER, and keep the owner URL only where
 * migrations run. Re-run after every migration (it is idempotent). See docs/DATABASE.md.
 */
import { provisionAppRole } from '../src/db/app-role.js';

const ownerUrl = process.env.DIRECT_DATABASE_URL;
const user = process.env.APP_DB_USER ?? 'lobbyup_app';
const password = process.env.APP_DB_PASSWORD;

if (!ownerUrl || !password) {
  console.error('Set DIRECT_DATABASE_URL (schema owner) and APP_DB_PASSWORD.');
  process.exit(1);
}

await provisionAppRole(ownerUrl, user, password);
console.log(`✔ role "${user}" provisioned with row-level (DML) access only; audit_logs append-only.`);
