import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, createUser, getApp, login, prisma, redis, resetDb } from '../helpers.js';

describe('authentication', () => {
  beforeAll(async () => {
    await resetDb();
    await getApp();
  });
  afterAll(closeApp);

  it('logs in, sets a hardened httpOnly cookie and returns the server-side identity', async () => {
    const u = await createUser('STUDENT');
    const app = await getApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: u.email, password: 'correct-horse-battery' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.user.roles).toEqual(['STUDENT']);
    expect(body.data.user.permissions).toContain('START_EXAM');
    expect(body.data.token).toBeUndefined(); // not exposed to JS by default
    const cookie = res.cookies.find((c) => c.name === 'lobbyup_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite?.toLowerCase()).toBe('lax');
    // Only a hash of the token is stored.
    const session = await prisma.session.findFirstOrThrow({ where: { userId: u.id } });
    expect(session.tokenHash).not.toBe(cookie.value);
    expect(session.tokenHash).toHaveLength(64);
  });

  it('rejects bad credentials with a generic error (no user enumeration)', async () => {
    const u = await createUser('STUDENT');
    const app = await getApp();
    const wrongPw = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: u.email, password: 'nope-nope-nope' } });
    const noUser = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'ghost@test.local', password: 'nope-nope-nope' } });
    expect(wrongPw.statusCode).toBe(401);
    expect(noUser.statusCode).toBe(401);
    expect(wrongPw.json().error).toEqual(noUser.json().error);
  });

  it('locks the account after repeated failures, without revealing the lock', async () => {
    const u = await createUser('STUDENT');
    const app = await getApp();
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: u.email, password: 'wrong-password' } });
    }
    // Even the correct password is refused while locked, with the same error as a wrong password.
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: u.email, password: 'correct-horse-battery' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('concurrent guesses cannot bypass the lockout (atomic failure counter)', async () => {
    const u = await createUser('STUDENT');
    const app = await getApp();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: u.email, password: `guess-${i}` } }),
      ),
    );
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.lockedUntil).not.toBeNull();
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: u.email, password: 'correct-horse-battery' } });
    expect(res.statusCode).toBe(401);
  });

  it('a successful login resets the failure counter', async () => {
    const u = await createUser('STUDENT');
    const app = await getApp();
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: u.email, password: 'wrong-password' } });
    }
    await login(u.email);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).failedLoginCount).toBe(0);
  });

  it('refuses inactive accounts', async () => {
    const u = await createUser('STUDENT', { status: 'SUSPENDED' });
    const app = await getApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: u.email, password: 'correct-horse-battery' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ACCOUNT_INACTIVE');
  });

  it('GET /auth/me requires a valid session', async () => {
    const app = await getApp();
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: 'Bearer forged-token-forged-token-123' } })).statusCode,
    ).toBe(401);
    const u = await createUser('PROCTOR');
    const c = await login(u.email);
    const me = await c.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.email).toBe(u.email);
  });

  it('logout revokes the session immediately', async () => {
    const u = await createUser('STUDENT');
    const c = await login(u.email);
    expect((await c.inject({ method: 'POST', url: '/api/v1/auth/logout' })).statusCode).toBe(200);
    expect((await c.inject({ method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401);
  });

  it('suspending a user kills their live sessions', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const a = await login(admin.email);
    const u = await createUser('STUDENT');
    const c = await login(u.email);
    const r = await a.inject({ method: 'PATCH', url: `/api/v1/admin/users/${u.id}`, payload: { status: 'SUSPENDED' } });
    expect(r.statusCode).toBe(200);
    expect((await c.inject({ method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401);
  });

  it('expired sessions are rejected', async () => {
    const u = await createUser('STUDENT');
    const c = await login(u.email);
    await prisma.session.updateMany({ where: { userId: u.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    // Drop the auth cache so the change is observed now rather than within its 60 s TTL.
    const cached = await redis.keys('lu:sess:*');
    if (cached.length) await redis.del(...cached);
    expect((await c.inject({ method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401);
  });

  it('changing password signs out other sessions', async () => {
    const u = await createUser('STUDENT');
    const c1 = await login(u.email);
    const c2 = await login(u.email);
    const r = await c1.inject({
      method: 'PUT',
      url: '/api/v1/auth/password',
      payload: { currentPassword: 'correct-horse-battery', newPassword: 'a-brand-new-password' },
    });
    expect(r.statusCode).toBe(200);
    expect((await c2.inject({ method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401);
    expect((await c1.inject({ method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(200);
  });

  it('rejects cross-site state-changing requests made with the cookie (CSRF)', async () => {
    const u = await createUser('STUDENT');
    const c = await login(u.email);
    const evil = await c.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { origin: 'https://evil.example' } });
    expect(evil.statusCode).toBe(403);
    expect(evil.json().error.code).toBe('CSRF_REJECTED');
  });

  it('uses the standard error envelope with no stack traces', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: '{"email":',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ success: false, error: { code: 'BAD_REQUEST', message: 'Malformed request.' } });
    expect(res.body).not.toMatch(/at .*\.ts:\d+/);
  });

  it('sets security headers', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});
