# Privacy & data handling

Lobbyup collects only what running and reviewing an examination needs.

## What is stored, and why

| Data | Purpose | Kept |
|---|---|---|
| Name, email, student id, password hash (Argon2id), account status | Identity and sign-in | Until the account is deleted by an administrator |
| Attempts, answers, results, scores, per-question marks | The exam itself; the academic record | As institutional policy requires (not purged automatically) |
| Violation score and human review decision on an attempt | Integrity review outcome | With the attempt |
| Proctoring events: type, timestamps, small metadata | Signals for **human** review; never an automatic penalty | `DATA_RETENTION_DAYS` after the attempt finishes (default 180), then deleted |
| Exam-session device info, IP address, user agent; IP on the attempt | Detecting device takeovers and investigating disputes | `DATA_RETENTION_DAYS` after the attempt finishes, then deleted or cleared |
| Login sessions: token hash, IP, user agent | Authentication and security | `SESSION_RETENTION_DAYS` after the session ends (default 30), then deleted |
| Audit log of administrative actions | Accountability | Kept (append-only for the application) |

The retention worker (`src/workers/retention.worker.ts`) enforces these periods. It runs every `RETENTION_SWEEP_INTERVAL_MS` (default 6 h) and deletes in small batches. Setting a retention value to `0` disables that rule.

## Data minimisation in the code
- **Event metadata** is limited to at most 12 short identifier keys with scalar values (strings of 200 characters or less), 1 KB in total. Nested objects and long strings are rejected. Clients therefore can't send clipboard contents, page snapshots, keystrokes or similar personal data. A `PASTE_ATTEMPT` records *that* a paste was attempted, not what was pasted.
- **Device info** sent at exam start is likewise limited to 20 short scalar fields.
- **No browser event decides anything on its own.** Events become weighted signals. Only a running total above the quiz's threshold flags an attempt, and a person decides (`CLEARED` / `CONFIRMED`). Network drops and focus regained after blurs carry zero weight.
- **Access:**
  - Students see only their own attempts and results.
  - Proctoring data is visible only with `VIEW_VIOLATIONS`.
  - Results of other students are visible only with `VIEW_ALL_RESULTS`.
  - The answer key is visible only to the quiz owner and super admins until no attempt can still write.
- **Logs** redact cookies, authorization headers, passwords and tokens.

## Future camera, microphone or screen monitoring
None of this is collected today. Before introducing any of it, **all** of the following must be in place:
1. **Explicit, informed consent** from each student, recorded server-side with a timestamp and the notice version. The exam must state what happens if consent is refused, for example an in-person alternative.
2. **A clear notice** before the exam: what is captured, when, who can see it, how long it is kept, and how to request deletion.
3. **A defined, short retention period**, enforced automatically like the rules above.
4. **Restricted access** through a dedicated permission, with every view recorded in the audit log.
5. **Secure storage**: encrypted at rest and in transit, kept out of the main database (use object storage with signed, expiring URLs), and never in backups that outlive the retention period.
6. **An approved institutional policy**, plus a data-protection impact assessment, before rollout.
