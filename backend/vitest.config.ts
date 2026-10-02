import { defineConfig } from 'vitest/config';

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://lobbyup:lobbyup@localhost:5432/lobbyup_test';

export default defineConfig({
  test: {
    globalSetup: ['tests/global-setup.ts'],
    // Integration tests share one database, so files run one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: `${TEST_DB}?connection_limit=10`,
      DIRECT_DATABASE_URL: TEST_DB,
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15',
      CORS_ORIGINS: 'http://localhost:3000',
      COOKIE_SECURE: 'false',
      WORKERS_ENABLED: 'false',
      SUBMIT_GRACE_SECONDS: '5',
      // Cheaper hashing keeps the suite fast; production uses the OWASP-recommended defaults.
      ARGON2_MEMORY_KIB: '8192',
      ARGON2_TIME_COST: '1',
      LOGIN_MAX_FAILURES: '5',
    },
  },
});
