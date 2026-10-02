# Load test results

The scenario is [`exam.k6.js`](exam.k6.js) and the integrity check is [`verify-loadtest.ts`](verify-loadtest.ts).

> **Scope.** These runs used one Windows laptop: the API (one Node process with in-process workers), Postgres 16 and Redis 7 in Docker, and k6 in Docker, all on the same machine. Network latency is close to zero and the hardware is much faster than a free-tier instance.
>
> The runs show that the **application** handles 500 concurrent students with no errors and no data loss. They do **not** show that a free-tier deployment (shared vCPU, remote Neon/Supabase and Upstash, cross-region latency) meets the PRD targets. **Repeat the test against the deployed stack before a real exam.**

## Scenario (per virtual student, 500 in parallel)
1. Log in (the 500 logins are spread over 60 s, using production Argon2id parameters).
2. `GET /quizzes`, `POST /attempts` (start), `GET /attempts/:id` (reload).
3. 40 autosaves at roughly 4 s intervals. 80% are new questions and 20% change an earlier answer, each with an increasing revision.
4. An event batch every 10 saves (`WINDOW_BLUR`/`WINDOW_FOCUS`).
5. One mid-exam offline-style `POST /sync` that re-sends up to 20 answers.
6. `POST /submit`, then `GET /results/:id`.

That is 51 requests per student, about 25,500 in total. Peak load is about 110 req/s with all 500 students active at once. The 4 s autosave interval is deliberately more aggressive than the 5–15 s debounce recommended for the frontend.

## Run 1 — baseline (2026-10-02)

Config: `NODE_ENV=production`, `connection_limit=20`, `WORKERS_ENABLED=true`, rate limits **on**.

| Metric | Result | PRD target |
|---|---|---|
| Concurrent students (VUs) | 500 | ~500 |
| HTTP requests | 25,500 | |
| Failed requests | **0 (0.00%)** | < 1% |
| Failed checks | **0 / 25,500** | |
| Exam endpoints P95 / P99 | **52 ms / 107 ms** | < 500 ms / < 1000 ms |
| All requests P95 / P99 / max | 69 ms / 124 ms / 368 ms | |
| Answer save P50 / P95 / P99 | 10 ms / 28 ms / 51 ms | |
| Submit P50 / P95 / P99 | 80 ms / 159 ms / 189 ms | |
| Login P50 / P95 / P99 | 98 ms / 185 ms / 265 ms | |
| Server warnings/errors logged | 0 | |

Integrity, checked in Postgres after the run:

| Check | Result |
|---|---|
| Answers acknowledged to clients (distinct questions) | 16,795 |
| Answers persisted in Postgres | **16,795** (none lost) |
| Attempts submitted / results | 500 / **500** |
| Duplicate results · duplicate answers · students with >1 attempt | **0 · 0 · 0** |
| Exam sessions left ACTIVE | 0 |

## Run 2 — after two adversarial review rounds (hardened build, 2026-10-02)

Same scenario and machine. Rate limits on, `ANSWER_BUFFER=redis` (default).

| Metric | Result | PRD target |
|---|---|---|
| Concurrent students | 500 | ~500 |
| HTTP requests / failed | 25,500 / **0 (0.00%)** | < 1% |
| Failed checks | **0 / 25,500** | |
| Exam endpoints P95 / P99 | **43 ms / 98 ms** | < 500 ms / < 1000 ms |
| Answer save P50 / P95 / P99 | 10 ms / 25 ms / 40 ms | |
| Submit P50 / P95 / P99 | 82 ms / 145 ms / 173 ms | |
| Login P50 / P95 / P99 | 96 ms / 169 ms / 215 ms | |
| Integrity | 16,811 / 16,811 answers persisted · 500 / 500 results · 0 duplicates | no lost answers, no duplicate submissions |
| Server warnings/errors logged | 0 | |

## Run 3 — `ANSWER_BUFFER=direct` (every autosave written straight to Postgres)

This is the mode recommended when the Redis plan has a tight command quota.

| Metric | Result | PRD target |
|---|---|---|
| HTTP requests / failed | 25,500 / **0 (0.00%)** | < 1% |
| Exam endpoints P95 / P99 | **78 ms / 158 ms** | < 500 ms / < 1000 ms |
| Answer save P50 / P95 / P99 | 26 ms / 60 ms / 84 ms | |
| Submit P50 / P95 / P99 | 152 ms / 253 ms / 277 ms | |
| Integrity | 16,833 / 16,833 answers persisted · 500 / 500 results · 0 duplicates | |

Direct mode costs about 2.4× more per autosave at P95 than buffered mode, plus one Postgres write per save. Both modes stay far inside the targets on this hardware.

The production Docker image was also verified: it built, applied all migrations to an empty database on boot, and started as the non-root `node` user with `/health/ready` green.

## Run 4 — final code after three adversarial review rounds (`ANSWER_BUFFER=redis`)

These are the numbers for the code as delivered. The final round added a takeover fence, a per-attempt superseded-write check on every flush, and lockout settlement on login. All of these add a little work per request.

| Metric | Result | PRD target |
|---|---|---|
| Concurrent students | 500 | ~500 |
| HTTP requests / failed | 25,500 / **0 (0.00%)** | < 1% |
| Failed checks | **0 / 25,500** | |
| Exam endpoints P95 / P99 | **54 ms / 127 ms** | < 500 ms / < 1000 ms |
| Answer save P50 / P95 / P99 | 14 ms / 35 ms / 55 ms | |
| Submit P50 / P95 / P99 | 111 ms / 172 ms / 200 ms | |
| Login P50 / P95 / P99 | 77 ms / 163 ms / 227 ms | |
| Integrity | 16,763 / 16,763 answers persisted · 500 / 500 results · 0 duplicates · 0 sessions left ACTIVE | no lost answers, no duplicate submissions |
| Server warnings/errors logged | 0 | |

## What to watch in a real deployment
- **Login burst CPU.** Argon2id costs about 30–60 ms of CPU per login. Five hundred logins in one minute on a 0.1–0.5 vCPU free instance can queue for several seconds. Open the login page 10–15 minutes before the exam starts.
- **Postgres connections.** Free tiers allow few direct connections. Use the provider's pooler and keep `connection_limit` at or below the pooler's per-client limit.
- **Redis round-trip latency.** Each autosave makes about 4 Redis calls (session cache, rate limit, attempt state, save script), some of them pipelined. A cross-region Upstash adds that round trip to every save, so put Redis in the same region as the API or use `ANSWER_BUFFER=direct`.
- **Upstash free command quota.** See README → *Deploying for ₹0*.
