import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Number of proxy hops to trust for X-Forwarded-For (Render/Fly/Koyeb sit behind 1 proxy). */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  /** Per-command Redis timeout. On timeout the Postgres fallbacks take over. */
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(100).default(1000),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),

  // Auth
  SESSION_COOKIE_NAME: z.string().default('lobbyup_session'),
  COOKIE_SECURE: bool(true),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  COOKIE_DOMAIN: z.string().optional(),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  SESSION_IDLE_MINUTES: z.coerce.number().positive().default(120),
  /** Also return the session token in the login body (for non-browser clients). Off by default. */
  AUTH_RETURN_TOKEN: bool(false),
  LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(10),
  LOGIN_LOCK_MINUTES: z.coerce.number().positive().default(15),
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(8192).default(19456),
  ARGON2_TIME_COST: z.coerce.number().int().min(1).default(2),
  /** Concurrent Argon2 operations. Keep <= vCPUs so a login burst cannot starve autosaves. */
  ARGON2_MAX_CONCURRENCY: z.coerce.number().int().min(1).default(2),
  /** Logins allowed to wait for a hashing slot before new ones get 503 (retryable). */
  ARGON2_MAX_QUEUE: z.coerce.number().int().min(1).default(500),

  // Exam behaviour
  /** Network grace after expires_at during which in-flight saves/submits are still accepted. */
  SUBMIT_GRACE_SECONDS: z.coerce.number().int().min(0).max(300).default(30),
  /** allow: a new device/login may take over an attempt (logged as SESSION_CHANGE). deny: reject. */
  EXAM_SESSION_TAKEOVER: z.enum(['allow', 'deny']).default('allow'),
  /**
   * redis: autosaves go to an atomic Redis buffer and are flushed to Postgres in batches (default).
   * direct: every autosave is written straight to Postgres (use when the Redis plan has a tight
   * command quota; Redis is then only used for caches and rate limits).
   */
  ANSWER_BUFFER: z.enum(['redis', 'direct']).default('redis'),
  /** Upper bound on stored proctoring events per attempt (protects free-tier storage). */
  MAX_EVENTS_PER_ATTEMPT: z.coerce.number().int().min(100).default(3000),

  // Workers
  WORKERS_ENABLED: bool(true),
  ANSWER_FLUSH_INTERVAL_MS: z.coerce.number().int().min(200).default(2000),
  EXPIRY_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1000).default(15000),

  RATE_LIMIT_ENABLED: bool(true),
  /**
   * Logins per minute from ONE IP. A whole exam hall often shares one NAT address, so this must
   * exceed the number of students who log in together. Brute force is stopped by per-account lockout.
   */
  LOGIN_RATE_LIMIT_PER_IP: z.coerce.number().int().positive().default(1500),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  const env = parsed.data;
  if (env.COOKIE_SAMESITE === 'none' && !env.COOKIE_SECURE) {
    console.error('COOKIE_SAMESITE=none requires COOKIE_SECURE=true');
    process.exit(1);
  }
  return env;
}

export const env = loadEnv();
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
