import { describe, expect, it } from 'vitest';
import { SaveAnswerBody, SubmitBody, SyncBody } from '../../src/modules/answers/answer.schemas.js';
import { LoginBody } from '../../src/modules/auth/auth.schemas.js';
import { EventsBody } from '../../src/modules/exam-events/event.schemas.js';
import { QuestionInput } from '../../src/modules/questions/question.schemas.js';
import { CreateQuizBody } from '../../src/modules/quizzes/quiz.schemas.js';
import { parse } from '../../src/utils/validate.js';

const uuid = '3f2a1c4e-8b7d-4e6f-9a1b-2c3d4e5f6a7b';

describe('request validation', () => {
  it('normalises login email and rejects unknown fields', () => {
    expect(parse(LoginBody, { email: '  A@B.COM ', password: 'x' }).email).toBe('a@b.com');
    expect(() => parse(LoginBody, { email: 'a@b.com', password: 'x', role: 'SUPER_ADMIN' })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 }),
    );
  });

  it('answers: rejects client-supplied score / userId and malformed responses', () => {
    expect(() => parse(SaveAnswerBody, { response: { selectedOptionIds: [uuid] }, revision: 1, score: 10 })).toThrow();
    expect(() => parse(SaveAnswerBody, { response: { selectedOptionIds: [uuid] }, revision: 1, userId: uuid })).toThrow();
    expect(() => parse(SaveAnswerBody, { response: { selectedOptionIds: ['not-a-uuid'] }, revision: 1 })).toThrow();
    expect(() => parse(SaveAnswerBody, { response: { selectedOptionIds: [uuid, uuid] }, revision: 1 })).toThrow();
    expect(() => parse(SaveAnswerBody, { response: { text: 'x' }, revision: -1 })).toThrow();
    expect(() => parse(SaveAnswerBody, { response: { text: 'x'.repeat(2001) }, revision: 1 })).toThrow();
    expect(parse(SaveAnswerBody, { response: { text: 'ok' }, revision: Date.now() }).revision).toBeGreaterThan(0);
  });

  it('sync: rejects duplicate questions in one batch', () => {
    const item = { questionId: uuid, response: { text: 'a' }, revision: 1 };
    expect(() => parse(SyncBody, { answers: [item, item] })).toThrow();
    expect(parse(SyncBody, { answers: [item] }).answers).toHaveLength(1);
  });

  it('submit: rejects score / status tampering', () => {
    expect(() => parse(SubmitBody, { score: 100 })).toThrow();
    expect(() => parse(SubmitBody, { status: 'SUBMITTED' })).toThrow();
    expect(parse(SubmitBody, {})).toEqual({});
  });

  it('events: enforces type enum, id format, size and reserved prefix', () => {
    expect(() => parse(EventsBody, { events: [{ clientEventId: 'e1', type: 'HACKED' }] })).toThrow();
    expect(() => parse(EventsBody, { events: [{ clientEventId: 'bad id!', type: 'TAB_HIDDEN' }] })).toThrow();
    expect(() => parse(EventsBody, { events: [{ clientEventId: 'server:x', type: 'TAB_HIDDEN' }] })).toThrow();
    expect(() =>
      parse(EventsBody, { events: [{ clientEventId: 'e1', type: 'TAB_HIDDEN', metadata: { big: 'x'.repeat(3000) } }] }),
    ).toThrow();
    expect(() => parse(EventsBody, { events: [] })).toThrow();
  });

  it('questions: structural rules per type', () => {
    const base = { prompt: 'Q', points: 1 };
    expect(() => parse(QuestionInput, { ...base, type: 'SINGLE_CHOICE', options: [{ text: 'a', isCorrect: true }, { text: 'b', isCorrect: true }] })).toThrow();
    expect(() => parse(QuestionInput, { ...base, type: 'SINGLE_CHOICE', options: [{ text: 'a', isCorrect: true }] })).toThrow();
    expect(() => parse(QuestionInput, { ...base, type: 'MULTIPLE_CHOICE', options: [{ text: 'a', isCorrect: false }, { text: 'b', isCorrect: false }] })).toThrow();
    expect(() => parse(QuestionInput, { ...base, type: 'SHORT_TEXT' })).toThrow();
    expect(() => parse(QuestionInput, { ...base, type: 'SHORT_TEXT', acceptedAnswers: ['x'], points: 0.001 })).toThrow();
    expect(parse(QuestionInput, { ...base, type: 'SHORT_TEXT', acceptedAnswers: ['x'] }).negativePoints).toBe(0);
  });

  it('quiz: duration bounds and schedule window', () => {
    expect(() => parse(CreateQuizBody, { title: 'T', durationSeconds: 10 })).toThrow();
    expect(() =>
      parse(CreateQuizBody, {
        title: 'T',
        durationSeconds: 600,
        startsAt: '2026-01-02T00:00:00Z',
        endsAt: '2026-01-01T00:00:00Z',
      }),
    ).toThrow();
    const ok = parse(CreateQuizBody, { title: 'T', durationSeconds: 600 });
    expect(ok.maxAttempts).toBe(1);
    expect(ok.resultsVisibility).toBe('AFTER_END');
  });
});
