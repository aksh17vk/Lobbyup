# Lobbyup — Backend

Online quiz / examination API built for roughly 500 concurrent students on ₹0 infrastructure.

**Stack:** Node.js (≥ 20.11) · TypeScript · Fastify 5 · PostgreSQL (Prisma 6) · Redis (ioredis) · Zod 4 · Argon2id · Vitest · k6 · Docker · pnpm

It is a **modular monolith**: one deployable, with a module per domain area. There are no microservices, queues, or Kubernetes. PostgreSQL is the source of truth. Redis holds only caches, rate-limit counters, and a short-lived answer buffer that is always drained into Postgres.

```
Student ──HTTPS──▶ Next.js ──▶ Lobbyup API (stateless, /api/v1)
                                   │            │
                                   ▼            ▼
                                 Redis      PostgreSQL
                         cache · rate limits  source of truth
                         answer buffer        (answers, results, events…)
```

---

## Quick start

```bash
cp .env.example .env               # then edit secrets
docker compose up -d postgres redis
pnpm install
pnpm prisma migrate deploy
pnpm db:seed                       # roles, permissions, first SUPER_ADMIN (+ demo data if SEED_DEMO=true)
pnpm dev                           # http://localhost:4000
```

```bash
pnpm test             # unit + integration + security (needs the compose Postgres/Redis)
pnpm typecheck
pnpm build && pnpm start
```

The test suite uses a separate `lobbyup_test` database (created by `docker/postgres-init.sql`) and Redis DB 15.

---

## Project layout

```
src/
├── config/env.ts            Zod-validated environment (fails fast on bad config)
├── db/                      Prisma client, Redis client + key naming
├── plugins/                 auth (session → AuthContext, CSRF), error handler, health
├── middleware/              requirePermission / requireAnyPermission, Redis rate limiter
├── utils/                   errors, validation, audit log, logger, crypto, pagination
├── modules/
│   ├── auth/                login, logout, me, change password, Argon2id hashing
│   ├── sessions/            auth sessions (hashed opaque tokens) + controlled exam sessions
│   ├── permissions/         permission catalogue, role defaults, authorization helpers
│   ├── roles/ users/        admin user & role management (escalation-safe)
│   ├── quizzes/             lifecycle state machine, content cache, student catalogue
│   ├── questions/           questions, options, question pools (DRAFT-only edits)
│   ├── attempts/            start/resume/view, server timer, randomisation, Redis state cache
│   ├── answers/             autosave → Redis (atomic Lua) → Postgres (batched, revision-guarded)
│   ├── submissions/         transactional idempotent finalisation, scoring
│   ├── results/             visibility rules, per-question breakdown
│   ├── exam-events/         anti-cheating events → signals → flag
│   └── admin/               attempts, violations, review, results, system status
├── workers/                 answer flush (write-behind), expiry sweep
├── app.ts  server.ts  worker.ts
prisma/                      schema, migrations (+ hand-written partial unique indexes), seed
tests/unit · tests/integration · tests/security
loadtest/                    seed, k6 scenario, integrity verifier
```

---

## How the critical parts work

### Authentication and RBAC
- Login issues a 256-bit opaque token. The browser gets it in an `httpOnly`, `Secure`, `SameSite` cookie; non-browser clients can use `Authorization: Bearer`. Only a SHA-256 hash of the token is stored.
- Each request resolves to an `AuthContext` (user, roles, permissions) built **only from server-side state** and cached in Redis for 60 s. Revocation, suspension, and role changes clear that cache immediately.
- Sessions have an absolute TTL (`SESSION_TTL_HOURS`) and an idle timeout (`SESSION_IDLE_MINUTES`). The account status is re-checked on every cache miss.
- Brute-force protection: per-account lockout after `LOGIN_MAX_FAILURES` failures. The counter is atomic: each attempt reserves a slot *before* the password check, so concurrent guesses can't share one. A locked account gives exactly the same response and timing as a wrong password, so lock state doesn't reveal which emails exist. Password changes go through the same lockout, and an attempt that fails for infrastructure reasons (busy hash queue, `503`) is refunded rather than counted. Unknown emails get a dummy hash, and there is a per-IP limit. Argon2 work is capped at `ARGON2_MAX_CONCURRENCY` with a bounded queue (overflow gets a retryable `503`), so a login storm can't starve autosaves.
- CSRF protection: state-changing requests authenticated by cookie must carry an allowed `Origin`, or `X-Requested-With`.
- Every request goes through: authenticate → identify → permission → **resource ownership** → **resource state**. Another student's attempt returns `404`, not `403`, so attempt ids can't be probed.

| Role | Permissions |
|---|---|
| SUPER_ADMIN | everything |
| EXAM_ADMIN | CREATE/EDIT/DELETE/PUBLISH_EXAM, MANAGE_QUESTIONS, VIEW_ALL_RESULTS, VIEW_ATTEMPTS, VIEW/REVIEW_VIOLATIONS. Can only modify quizzes they created. |
| PROCTOR | VIEW_ATTEMPTS, VIEW_VIOLATIONS, REVIEW_VIOLATIONS |
| STUDENT | START_EXAM, SAVE_ANSWER, SUBMIT_EXAM, VIEW_OWN_RESULT |

You can edit roles and assign them to users through the API, but outside SUPER_ADMIN you can only grant, remove, or edit roles whose permissions you hold yourself. You can only reset, suspend, or re-role users whose permissions are a subset of yours. The self-service student permissions are exempt from that check, so user managers can still create students. Only a SUPER_ADMIN can grant SUPER_ADMIN.

### Quiz lifecycle
`DRAFT → PUBLISHED → ACTIVE → ENDED → ARCHIVED`. A PUBLISHED quiz can go back to DRAFT while no attempts exist, and a DRAFT can be archived.
- Questions, options and pools can only change in **DRAFT**. Each change bumps `content_version`, so the content cache is never stale.
- Publishing validates the content: at least one question, valid correct options, and pools large enough for their draw count.
- Students can start an attempt only while the quiz is **ACTIVE** and inside `startsAt`/`endsAt`.

### Attempts and the server-side timer
- `POST /attempts` is idempotent. A live attempt is resumed instead of duplicated. A partial unique index (one IN_PROGRESS/SUBMITTING attempt per student per quiz) makes concurrent starts collapse onto one row.
- `started_at` and `expires_at` come from the **server clock**: `expires_at = min(start + duration, quiz.endsAt)`. Every save and submit checks them. The client only uses `expiresAt` and `serverTime` to draw its countdown, so changing the system clock changes nothing.
- Question order, pool draws, and option order are randomised once with a CSPRNG and **persisted** in `attempt_questions`. Reloads, other devices, and grading all see the same mapping.
- Students never receive `isCorrect` or `acceptedAnswers`.

### Answer saving: write-behind with no lost answers
```
PUT /answers/:q ─▶ validate against this attempt's questions/options
               ─▶ Redis Lua (atomic): status == IN_PROGRESS? deadline OK? exam session current?
                                       keep highest revision · mark attempt dirty
flush worker (2 s) ─▶ INSERT … ON CONFLICT (attempt_id, question_id)
                      DO UPDATE … WHERE answers.revision < EXCLUDED.revision
```
- The client sends a monotonically increasing `revision` per question (for example a counter or `Date.now()`). Retries come back as `duplicate` and out-of-order requests as `stale`. The newest answer always wins, and `UNIQUE(attempt_id, question_id)` rules out duplicate rows.
- Postgres takes the attempt row `FOR SHARE` and requires `IN_PROGRESS`/`SUBMITTING`, so no answer can land after finalisation.
- Redis commands time out after `REDIS_COMMAND_TIMEOUT_MS`. If Redis is unavailable, saves go **straight to Postgres**, which enforces state and the deadline in SQL, and attempt state is read from Postgres. Each item's status comes from the rows actually written.
- `ANSWER_BUFFER=direct` writes every autosave straight to Postgres. Use it when the Redis plan has a tight command quota; Redis is then used only for caches and rate limits.
- The background flush writes only the questions that changed since the last flush. If Postgres rejects a value as unstorable, that one value is quarantined and logged, so it can't block the rest of the attempt.
- Redis runs with AOF and `noeviction` (see `docker-compose.yml`). On shutdown the buffer is drained.

### Offline recovery
The client keeps answers locally while offline. On reconnect it calls `POST /attempts/:id/sync` with everything it holds. The server applies the same revision rules and returns its authoritative `serverAnswers` so the client can reconcile. `OFFLINE`/`ONLINE` events have zero weight, so a network outage never penalises a student.

### Submission (transactional and idempotent)
1. `IN_PROGRESS → SUBMITTING` (conditional update). From that moment the Lua script rejects new saves.
2. The attempt's Redis buffer is drained into Postgres. If that fails, finalisation **aborts** with `503` instead of grading without some answers.
3. One transaction: `SELECT … FOR UPDATE`, re-check state, grade from stored answers, write per-answer marks and the `Result` (`UNIQUE(attempt_id)`), set `SUBMITTED`/`EXPIRED`.

The final status is decided inside the locked transaction from *when* finalisation began: within `expires_at + grace` → `SUBMITTED`, otherwise → `EXPIRED`. An interrupted expiry can therefore never be recorded as a submission. Repeated or concurrent submits return the existing result with `alreadySubmitted: true`. Scores are computed in integer hundredths, which handles negative marking without float drift. The **expiry worker** auto-submits attempts whose timer ran out (closed laptop, dead battery) and completes submissions interrupted by a crash.

### Controlled exam sessions
Each attempt has exactly one `ACTIVE` exam session, which records device metadata, IP, user agent, created time, last activity, expiry, and status. Every write must send `X-Exam-Session-Id`.
- A reload by the same login reuses the session.
- A different device or login takes over by default (`EXAM_SESSION_TAKEOVER=allow`), so a crashed laptop never locks a student out. The old session is marked `SUPERSEDED` and a `SESSION_CHANGE` signal is recorded for review.
- The takeover and its `SESSION_CHANGE` signal are written in one transaction, which also locks the attempt so a takeover can't race finalisation. If the Redis copy is stale, every write re-checks Postgres before rejecting, so the legitimate device is never locked out. Cache writes carry a session generation, so a stale refresh can't roll back to the old session.
- Each buffered answer records which exam session wrote it. Anything a superseded session wrote after it was superseded is never persisted or graded.
- Set `EXAM_SESSION_TAKEOVER=deny` to block takeover instead.
- Students are identified by session, never by IP.

### Anti-cheating
`POST /attempts/:id/events` takes batches of up to 100 events (`clientEventId` makes retries idempotent).

events → weighted signals (for example `TAB_HIDDEN`=1, `PASTE_ATTEMPT`=2, `OFFLINE`=0) → `violation_score` → flag at the quiz's `violationThreshold` → `PENDING` human review (`CLEARED`/`CONFIRMED`).

Events are inserted and scored in one transaction, and whether the attempt is still live is read from Postgres in that same transaction. Each attempt can store at most `MAX_EVENTS_PER_ATTEMPT` events: a batch is only charged if it fits, and duplicates are refunded. Events received after the attempt closed are kept for the timeline with zero weight, and only within 10 minutes of the actual close. A `CLEARED` attempt goes back to `PENDING` each time its score crosses the next multiple of the threshold.

A single event is never treated as proof of cheating, and flagged attempts are never auto-penalised.

### Results visibility
`IMMEDIATE`, `AFTER_END` (released when the quiz is ENDED), or `HIDDEN` (staff only). The score is released according to that setting.

The quiz owner and super admins always see the answer key. Students and other staff see it, along with per-question correctness (`isCorrect`, `pointsAwarded`, `acceptedAnswers`), only once the quiz is ENDED **and no attempt is still in progress**. Ending a quiz doesn't cut short attempts already running, and their owners must not be able to get the key from a classmate.

---

## API (all under `/api/v1`)

Responses use `{ "success": true, "data": … }` on success and `{ "success": false, "error": { "code", "message", "details?" } }` on failure. Stack traces and internals are never returned in production.

| Method | Path | Permission |
|---|---|---|
| POST | `/auth/login` · `/auth/logout` · `/auth/logout-all` | – / auth |
| GET | `/auth/me` | auth |
| PUT | `/auth/password` | auth |
| GET | `/quizzes` · `/quizzes/:quizId` | auth |
| POST | `/attempts` `{quizId, deviceInfo?}` | START_EXAM |
| GET | `/attempts/:attemptId` | owner (START_EXAM) or VIEW_ATTEMPTS |
| POST | `/attempts/:attemptId/resume` | START_EXAM, owner |
| PUT | `/attempts/:attemptId/answers/:questionId` `{response, revision, clientSavedAt?}` | SAVE_ANSWER, owner, exam session |
| POST | `/attempts/:attemptId/sync` `{answers[]}` | SAVE_ANSWER, owner, exam session |
| POST | `/attempts/:attemptId/submit` `{answers?[]}` | SUBMIT_EXAM, owner, exam session |
| POST | `/attempts/:attemptId/events` `{events[]}` | START_EXAM, owner |
| GET | `/results/:attemptId` | owner (VIEW_OWN_RESULT, per visibility) or VIEW_ALL_RESULTS |
| POST/GET | `/admin/quizzes` | CREATE_EXAM / EDIT_EXAM… |
| GET/PUT/DELETE | `/admin/quizzes/:quizId` | EDIT_EXAM / DELETE_EXAM (+ owner) |
| POST | `/admin/quizzes/:quizId/{publish,unpublish,activate,end,archive}` | PUBLISH_EXAM (+ owner) |
| POST | `/admin/quizzes/:quizId/questions` (one or `{questions:[…]}`) · `/admin/quizzes/:quizId/pools` | MANAGE_QUESTIONS |
| PUT/DELETE | `/admin/questions/:questionId` · `/admin/pools/:poolId` | MANAGE_QUESTIONS |
| GET | `/admin/attempts` · `/admin/attempts/:attemptId` | VIEW_ATTEMPTS |
| GET | `/admin/attempts/:attemptId/events` | VIEW_VIOLATIONS |
| POST | `/admin/attempts/:attemptId/cancel` | EDIT_EXAM |
| GET | `/admin/violations` | VIEW_VIOLATIONS |
| POST | `/admin/violations/:attemptId/review` | REVIEW_VIOLATIONS |
| GET | `/admin/results` | VIEW_ALL_RESULTS |
| GET/POST | `/admin/users` · PATCH `/admin/users/:userId` · POST `…/reset-password` · `…/revoke-sessions` | MANAGE_USERS |
| PUT | `/admin/users/:userId/roles` · `/admin/roles/:roleId/permissions`; GET `/admin/roles` · `/admin/permissions` | MANAGE_ROLES |
| GET | `/admin/system/status` | SYSTEM_SETTINGS |

Health probes (no auth): `GET /health/live` and `GET /health/ready`. Readiness requires only Postgres. Without Redis the API keeps serving on its Postgres fallbacks and reports `cache: "degraded"`, so a platform health check won't take it out of rotation. The API and worker also boot while Redis is down.

### Rate limits (per user; per IP only before login)
| Bucket | Limit/min | Bucket | Limit/min |
|---|---|---|---|
| login (per IP) | `LOGIN_RATE_LIMIT_PER_IP` (1500) | answer save | 180 |
| auth | 30 | sync | 30 |
| attempt start/resume | 20 | submit | 10 |
| events | 60 | admin | 300 |

Limits are keyed by **user**, so a whole exam hall behind one NAT IP doesn't share a single bucket. The login limit per IP is deliberately high for the same reason; brute force is stopped by per-account lockout. If Redis is down, the limiter fails open.

### Frontend contract (summary)
- Debounce autosave to every 5–15 s per changed question. Send a monotonically increasing `revision`, preferably `Date.now()` so that revisions from different devices order correctly. Never lower a local revision to match one the server reports.
- Keep answers in local storage. On reconnect, `POST /sync`, then reconcile with `serverAnswers`. If the response has `answersComplete: false` (answer buffer temporarily unreachable), keep the local copy: the server list may be missing newer saves.
- Send `X-Exam-Session-Id` (from start/resume) on every write. On `EXAM_SESSION_SUPERSEDED`, ask the student before calling `/resume`.
- Render the countdown from `expiresAt − serverTime`, never from the device clock alone.
- Batch events (up to 100) with unique `clientEventId`s.
- On `503` from submit, retry: answers are safe.

---

## Deploying for ₹0

| Piece | Free option | Notes |
|---|---|---|
| API | Render / Koyeb / Fly.io free instance (Docker) | `TRUST_PROXY=1`. Free Render instances sleep when idle, so warm the instance up before the exam. |
| Postgres | Neon or Supabase free | Put the **pooled** URL in `DATABASE_URL` (with `?pgbouncer=true&connection_limit=10`) and the direct URL in `DIRECT_DATABASE_URL`. |
| Redis | Upstash free (`rediss://…`) or Redis on the same VM | Supports Lua. An autosave costs about 4 Redis commands (session cache, rate limit, attempt state, save script). 500 students saving every 10 s for an hour ≈ 180k saves ≈ 720k commands, which **can exceed a free monthly quota in a single exam**. Check your plan. If it's tight, use `ANSWER_BUFFER=direct` or self-host Redis next to the API. |
| Frontend | Vercel | Proxy `/api` through Next.js rewrites to keep cookies first-party with `SameSite=lax`. Otherwise use `COOKIE_SAMESITE=none`. |

The Docker image runs `prisma migrate deploy` on boot. Required secrets come from environment variables only; `.env` is git-ignored.

**Most headroom for ₹0:** a free-tier VM (for example Oracle Cloud Always Free) running `docker compose` with the API, Postgres and Redis on the same machine. That removes every per-request network hop and command quota. Back up Postgres off-box.

To scale later: run several API instances behind a load balancer (they're stateless). Set `WORKERS_ENABLED=false` on them and run `node dist/worker.js` once; the workers are safe to run concurrently. Redis must be a single primary, because the save script uses keys in several slots.

---

## Load testing

```bash
LOADTEST_STUDENTS=500 pnpm loadtest:seed     # 500 students + a 40-question ACTIVE quiz → loadtest/fixture.json
NODE_ENV=production AUTH_RETURN_TOKEN=true pnpm start
docker run --rm -v "$PWD/loadtest:/scripts" grafana/k6 run \
  -e BASE_URL=http://host.docker.internal:4000 -e VUS=500 /scripts/exam.k6.js
pnpm exec tsx --env-file=.env loadtest/verify-loadtest.ts <distinct_answers_saved> <attempts_submitted>
```

The scenario ramps 500 logins over 60 s, then each student starts, reloads, autosaves 40 times (every ~4 s), sends events, does a mid-exam offline sync, submits, and reads the result. The thresholds are the PRD targets: P95 < 500 ms, P99 < 1000 ms, errors < 1%. The verifier then checks Postgres for lost answers and duplicate answers, results, or attempts.

> A run on one developer laptop shows whether the application keeps up. It does **not** prove that a free-tier deployment supports 500 users. Repeat the test against the real deployed stack (same region, same database and Redis plans) before an exam. See `loadtest/RESULTS.md` for recorded runs.
