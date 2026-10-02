import { Redis, type Result } from 'ioredis';
import { env } from '../config/env.js';

export const redis = new Redis(env.REDIS_URL, {
  // Fail fast so the Postgres fallbacks engage instead of requests hanging on a sick Redis.
  maxRetriesPerRequest: 1,
  commandTimeout: env.REDIS_COMMAND_TIMEOUT_MS,
  connectTimeout: 3000,
  keepAlive: 10_000,
  enableAutoPipelining: true,
  lazyConnect: true,
  // Upstash / managed Redis (rediss://) works without extra options.
});

/** Centralised key naming so nothing collides across modules. */
export const keys = {
  session: (tokenHash: string) => `lu:sess:${tokenHash}`,
  rate: (name: string, subject: string, window: number) => `lu:rl:${name}:${subject}:${window}`,
  quizContent: (quizId: string, version: number) => `lu:quiz:${quizId}:v${version}`,
  attemptMeta: (attemptId: string) => `lu:att:${attemptId}`,
  attemptAnswers: (attemptId: string) => `lu:att:${attemptId}:ans`,
  /** Question ids changed since the last background flush. */
  attemptChanged: (attemptId: string) => `lu:att:${attemptId}:chg`,
  attemptEventCount: (attemptId: string) => `lu:att:${attemptId}:evc`,
  dirtyAttempts: () => `lu:ans:dirty`,
};

// ───────────── Lua scripts (sent once, then invoked by SHA via EVALSHA) ─────────────

const RATE_LIMIT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return c`;

/**
 * Atomic answer save. KEYS: meta, answers hash, dirty set, changed set.
 * ARGV: nowMs, graceMs, examSessionId, attemptId, answersTtlAtMs, then (questionId, revision, payload)*.
 *   1. re-checks attempt state, server-side deadline and the active exam session,
 *   2. keeps only the highest revision per question,
 *   3. records the question as changed and the attempt as dirty for the flush worker.
 * Because state is checked inside the same script that writes, a save can never slip in
 * after finalisation has moved the attempt to SUBMITTING.
 * Returns: [code, (status, serverRevision)*]
 *   code 1 ok · -1 meta missing · -2 not IN_PROGRESS · -3 past deadline · -4 wrong exam session
 *   status 1 accepted · 0 duplicate (same revision) · -1 stale (older revision)
 * Revisions are returned as the stored digit string (Lua numbers lose precision past 14 digits).
 */
const SAVE_ANSWERS = `
local uid = redis.call('HGET', KEYS[1], 'userId')
if not uid then return {-1} end
if redis.call('HGET', KEYS[1], 'status') ~= 'IN_PROGRESS' then return {-2} end
local exp = tonumber(redis.call('HGET', KEYS[1], 'expiresAt'))
if tonumber(ARGV[1]) > exp + tonumber(ARGV[2]) then return {-3} end
if redis.call('HGET', KEYS[1], 'examSessionId') ~= ARGV[3] then return {-4} end
local out = {1}
local changed = false
for i = 6, #ARGV, 3 do
  local qid = ARGV[i]
  local revStr = ARGV[i + 1]
  local rev = tonumber(revStr)
  local cur = redis.call('HGET', KEYS[2], qid)
  local curStr = '-1'
  local curRev = -1
  if cur then
    curStr = string.match(cur, '^(%d+)|')
    curRev = tonumber(curStr)
  end
  if rev > curRev then
    redis.call('HSET', KEYS[2], qid, revStr .. '|' .. ARGV[i + 2])
    redis.call('SADD', KEYS[4], qid)
    changed = true
    table.insert(out, 1)
    table.insert(out, revStr)
  elseif rev == curRev then
    table.insert(out, 0)
    table.insert(out, curStr)
  else
    table.insert(out, -1)
    table.insert(out, curStr)
  end
end
if changed then
  redis.call('SADD', KEYS[3], ARGV[4])
  redis.call('PEXPIREAT', KEYS[2], ARGV[5])
  redis.call('PEXPIREAT', KEYS[4], ARGV[5])
end
return out`;

/**
 * Monotonic attempt-state write. Refuses to move status backwards
 * (IN_PROGRESS < SUBMITTING < SUBMITTED/EXPIRED/CANCELLED) and, at equal status, refuses an older
 * exam-session generation — so a slow or replayed refresh built before a takeover can never put
 * the superseded session back. Returns 1 if written, 0 if refused.
 * ARGV: status, userId, quizId, expiresAt, quizVersion, examSessionId, qmap, expireAtMs, sessionGen
 */
const WRITE_META = `
local rank = { IN_PROGRESS = 0, SUBMITTING = 1, SUBMITTED = 2, EXPIRED = 2, CANCELLED = 2 }
local cur = redis.call('HGET', KEYS[1], 'status')
if cur and rank[cur] then
  if rank[cur] > rank[ARGV[1]] then return 0 end
  if rank[cur] == rank[ARGV[1]] then
    local g = tonumber(redis.call('HGET', KEYS[1], 'sessionGen') or '0') or 0
    if tonumber(ARGV[9]) < g then return 0 end
  end
end
redis.call('HSET', KEYS[1], 'status', ARGV[1], 'userId', ARGV[2], 'quizId', ARGV[3], 'expiresAt', ARGV[4],
  'quizVersion', ARGV[5], 'examSessionId', ARGV[6], 'qmap', ARGV[7], 'sessionGen', ARGV[9])
redis.call('PEXPIREAT', KEYS[1], ARGV[8])
return 1`;

/** Atomically take (and clear) the set of changed questions, returning their buffered values. */
const TAKE_CHANGED = `
local ids = redis.call('SMEMBERS', KEYS[1])
if #ids == 0 then return {} end
redis.call('DEL', KEYS[1])
local vals = redis.call('HMGET', KEYS[2], unpack(ids))
local out = {}
for i = 1, #ids do
  if vals[i] then
    table.insert(out, ids[i])
    table.insert(out, vals[i])
  end
end
return out`;

/** Compare-and-delete: remove a buffered answer only if it is still the given revision. */
const QUARANTINE = `
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if cur and string.match(cur, '^(%d+)|') == ARGV[2] then return redis.call('HDEL', KEYS[1], ARGV[1]) end
return 0`;

/** Reserve n units of a budget only if it fits (no partial charge). Returns new total or -1. */
const RESERVE_BUDGET = `
local n = (tonumber(redis.call('GET', KEYS[1]) or '0') or 0) + tonumber(ARGV[1])
if n > tonumber(ARGV[2]) then return -1 end
redis.call('SET', KEYS[1], n, 'EX', ARGV[3])
return n`;

/** Delete a key only if it still holds the value we read (never erases a tombstone written since). */
const DEL_IF_EQ = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

/** Takeover fence: while a takeover commits, no exam session may write through the cache. */
const FENCE_SESSION = `
if redis.call('HGET', KEYS[1], 'status') == 'IN_PROGRESS' then
  redis.call('HSET', KEYS[1], 'examSessionId', '')
  return 1
end
return 0`;

redis.defineCommand('luRateLimit', { numberOfKeys: 1, lua: RATE_LIMIT });
redis.defineCommand('luSaveAnswers', { numberOfKeys: 4, lua: SAVE_ANSWERS });
redis.defineCommand('luWriteMeta', { numberOfKeys: 1, lua: WRITE_META });
redis.defineCommand('luTakeChanged', { numberOfKeys: 2, lua: TAKE_CHANGED });
redis.defineCommand('luQuarantine', { numberOfKeys: 1, lua: QUARANTINE });
redis.defineCommand('luReserveBudget', { numberOfKeys: 1, lua: RESERVE_BUDGET });
redis.defineCommand('luDelIfEq', { numberOfKeys: 1, lua: DEL_IF_EQ });
redis.defineCommand('luFenceSession', { numberOfKeys: 1, lua: FENCE_SESSION });

declare module 'ioredis' {
  interface RedisCommander<Context> {
    luRateLimit(key: string, windowMs: number): Result<number, Context>;
    luSaveAnswers(...args: (string | number)[]): Result<(number | string)[], Context>;
    luWriteMeta(key: string, ...args: (string | number)[]): Result<number, Context>;
    luTakeChanged(changedKey: string, answersKey: string): Result<string[], Context>;
    luQuarantine(answersKey: string, questionId: string, revision: string): Result<number, Context>;
    luReserveBudget(key: string, count: number, max: number, ttlSeconds: number): Result<number, Context>;
    luDelIfEq(key: string, expected: string): Result<number, Context>;
    luFenceSession(metaKey: string): Result<number, Context>;
  }
}
