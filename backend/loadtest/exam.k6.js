/**
 * Lobbyup exam load test (k6).
 *
 * Models a real exam: students log in over a ramp (login storm), start the attempt,
 * autosave answers on a debounced cadence, emit proctoring events, do an offline-style
 * batch sync, then submit and fetch the result.
 *
 *   k6 run -e BASE_URL=http://localhost:4000 -e VUS=500 loadtest/exam.k6.js
 *
 * Requires the API to run with AUTH_RETURN_TOKEN=true (k6 uses Bearer auth).
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const fixture = JSON.parse(open('./fixture.json'));
const BASE = `${__ENV.BASE_URL || 'http://localhost:4000'}/api/v1`;
const VUS = Number(__ENV.VUS || fixture.students);
const RAMP = __ENV.RAMP || '60s';
const SAVES_PER_STUDENT = Number(__ENV.SAVES || 40);
const SAVE_INTERVAL = Number(__ENV.SAVE_INTERVAL || 4); // seconds between autosaves

const distinctAnswers = new Counter('lobbyup_distinct_answers_saved');
const submitted = new Counter('lobbyup_attempts_submitted');
const saveLatency = new Trend('lobbyup_answer_save_ms', true);
const submitLatency = new Trend('lobbyup_submit_ms', true);
const loginLatency = new Trend('lobbyup_login_ms', true);

export const options = {
  scenarios: {
    exam: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: '30m',
    },
  },
  thresholds: {
    // PRD §20 targets (engineering targets, validated here — not guarantees).
    http_req_failed: ['rate<0.01'],
    'http_req_duration{kind:exam}': ['p(95)<500', 'p(99)<1000'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function json(res) {
  try {
    return res.json();
  } catch (_) {
    return null;
  }
}

export default function () {
  const n = exec.vu.idInTest;
  const email = fixture.emailPattern.replace('NNNN', String(n).padStart(4, '0'));
  // Spread logins over the ramp window like students arriving at the hall.
  const rampSeconds = parseInt(RAMP, 10);
  sleep((rampSeconds * (n - 1)) / VUS);

  const login = http.post(`${BASE}/auth/login`, JSON.stringify({ email, password: fixture.password }), {
    headers: { 'content-type': 'application/json' },
    tags: { name: 'login', kind: 'auth' },
  });
  loginLatency.add(login.timings.duration);
  if (!check(login, { 'login 200': (r) => r.status === 200 })) return;
  const token = json(login).data.token;
  if (!token) throw new Error('Run the API with AUTH_RETURN_TOKEN=true');
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const list = http.get(`${BASE}/quizzes`, { headers: auth, tags: { name: 'list quizzes', kind: 'exam' } });
  check(list, { 'quizzes 200': (r) => r.status === 200 });

  const start = http.post(`${BASE}/attempts`, JSON.stringify({ quizId: fixture.quizId, deviceInfo: { agent: 'k6' } }), {
    headers: auth,
    tags: { name: 'start attempt', kind: 'exam' },
  });
  if (!check(start, { 'start 2xx': (r) => r.status === 201 || r.status === 200 })) return;
  const view = json(start).data;
  const attemptId = view.attempt.id;
  const xs = Object.assign({}, auth, { 'x-exam-session-id': view.examSessionId });
  const questions = view.questions;

  // Reload once (students refresh pages).
  check(http.get(`${BASE}/attempts/${attemptId}`, { headers: auth, tags: { name: 'get attempt', kind: 'exam' } }), {
    'get attempt 200': (r) => r.status === 200,
  });

  const answered = new Set();
  const revisions = {};
  for (let i = 0; i < SAVES_PER_STUDENT; i++) {
    sleep(SAVE_INTERVAL * (0.5 + Math.random()));
    // Mostly new questions, sometimes changing an earlier answer.
    const q = questions[Math.random() < 0.8 ? i % questions.length : Math.floor(Math.random() * questions.length)];
    revisions[q.questionId] = (revisions[q.questionId] || 0) + 1;
    const response =
      q.type === 'SHORT_TEXT'
        ? { text: `answer${Math.floor(Math.random() * 40)}` }
        : { selectedOptionIds: [q.options[Math.floor(Math.random() * q.options.length)].id] };
    const res = http.put(
      `${BASE}/attempts/${attemptId}/answers/${q.questionId}`,
      JSON.stringify({ response, revision: revisions[q.questionId], clientSavedAt: new Date().toISOString() }),
      { headers: xs, tags: { name: 'save answer', kind: 'exam' } },
    );
    saveLatency.add(res.timings.duration);
    if (check(res, { 'save 200': (r) => r.status === 200 }) && !answered.has(q.questionId)) {
      answered.add(q.questionId);
      distinctAnswers.add(1);
    }

    if (i % 10 === 5) {
      const events = [
        { clientEventId: `${attemptId.slice(0, 8)}-${i}-a`, type: 'WINDOW_BLUR', timestamp: new Date().toISOString() },
        { clientEventId: `${attemptId.slice(0, 8)}-${i}-b`, type: 'WINDOW_FOCUS', timestamp: new Date().toISOString() },
      ];
      check(http.post(`${BASE}/attempts/${attemptId}/events`, JSON.stringify({ events }), { headers: xs, tags: { name: 'events', kind: 'exam' } }), {
        'events 202': (r) => r.status === 202,
      });
    }
    if (i === Math.floor(SAVES_PER_STUDENT / 2)) {
      // Offline recovery: resend everything held locally (all duplicates by now).
      const answers = Object.keys(revisions).slice(0, 20).map((questionId) => {
        const qq = questions.find((x) => x.questionId === questionId);
        return {
          questionId,
          revision: revisions[questionId],
          response: qq.type === 'SHORT_TEXT' ? { text: 'answer0' } : { selectedOptionIds: [qq.options[0].id] },
        };
      });
      check(http.post(`${BASE}/attempts/${attemptId}/sync`, JSON.stringify({ answers }), { headers: xs, tags: { name: 'sync', kind: 'exam' } }), {
        'sync 200': (r) => r.status === 200,
      });
    }
  }

  const submit = http.post(`${BASE}/attempts/${attemptId}/submit`, JSON.stringify({}), {
    headers: xs,
    tags: { name: 'submit', kind: 'exam' },
  });
  submitLatency.add(submit.timings.duration);
  if (check(submit, { 'submit 200': (r) => r.status === 200 })) submitted.add(1);

  check(http.get(`${BASE}/results/${attemptId}`, { headers: auth, tags: { name: 'result', kind: 'exam' } }), {
    'result 200': (r) => r.status === 200,
  });
}
