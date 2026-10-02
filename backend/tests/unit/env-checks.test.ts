import { describe, expect, it } from 'vitest';
import { productionProblems, productionWarnings } from '../../src/config/env.js';

describe('production configuration checks', () => {
  const base = {
    COOKIE_SECURE: true,
    DATABASE_URL: 'postgresql://app:S3cure-long-pass@db.example.com:5432/lobbyup?sslmode=require',
    REDIS_URL: 'rediss://default:pw@redis.example.com:6379',
    ALLOW_DEV_CREDENTIALS: false,
  };

  it('accepts a hardened configuration', () => {
    expect(productionProblems(base)).toEqual([]);
    expect(productionWarnings(base)).toEqual([]);
  });

  it('refuses insecure cookies and the public development database credentials', () => {
    expect(productionProblems({ ...base, COOKIE_SECURE: false })).toHaveLength(1);
    expect(productionProblems({ ...base, DATABASE_URL: 'postgresql://lobbyup:lobbyup@db.example.com/lobbyup' })).toHaveLength(1);
    // Explicit opt-in for local production-mode testing only.
    expect(
      productionProblems({ ...base, DATABASE_URL: 'postgresql://lobbyup:lobbyup@localhost/lobbyup', ALLOW_DEV_CREDENTIALS: true }),
    ).toEqual([]);
  });

  it('warns about remote connections without TLS, but not same-host ones', () => {
    expect(productionWarnings({ ...base, DATABASE_URL: 'postgresql://app:pw@db.example.com/lobbyup' })).toHaveLength(1);
    expect(productionWarnings({ ...base, REDIS_URL: 'redis://redis.example.com:6379' })).toHaveLength(1);
    expect(productionWarnings({ DATABASE_URL: 'postgresql://app:pw@postgres:5432/lobbyup', REDIS_URL: 'redis://redis:6379' })).toEqual([]);
  });
});
