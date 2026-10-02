import { execSync } from 'node:child_process';
import { provisionAppRole } from '../src/db/app-role.js';
import { TEST_APP_PASSWORD, TEST_APP_USER, TEST_OWNER_DB } from '../vitest.config.js';

/**
 * Once per run: migrate the test database as the schema owner, then provision the
 * least-privileged app role that the whole suite (and therefore the API) runs as.
 */
export default async function setup() {
  execSync('npx prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: TEST_OWNER_DB, DIRECT_DATABASE_URL: TEST_OWNER_DB },
  });
  await provisionAppRole(TEST_OWNER_DB, TEST_APP_USER, TEST_APP_PASSWORD);
}
