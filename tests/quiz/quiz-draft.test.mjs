import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseQuizDraft,
  quizDraftStorageKey,
  restoreQuizDraft,
  writeQuizDraft,
} from '../../lib/quiz-draft.ts';

const questions = [
  {
    id: 'question-1',
    selectedOptionId: 'server-option-1',
    options: [{ id: 'server-option-1' }, { id: 'local-option-1' }],
  },
  {
    id: 'question-2',
    selectedOptionId: null,
    options: [{ id: 'option-2' }, { id: 'other-option-2' }],
  },
  {
    id: 'question-3',
    selectedOptionId: 'server-option-3',
    options: [{ id: 'server-option-3' }, { id: 'other-option-3' }],
  },
];

test('device-local answers restore and override an older server projection', () => {
  const restored = restoreQuizDraft('attempt-1', questions, {
    attemptId: 'attempt-1',
    currentIndex: 1,
    answers: [
      { questionId: 'question-2', optionId: 'option-2' },
      { questionId: 'question-3', optionId: 'other-option-3' },
    ],
  });

  assert.deepEqual(restored.answers, [
    { questionId: 'question-1', optionId: 'server-option-1' },
    { questionId: 'question-2', optionId: 'option-2' },
    { questionId: 'question-3', optionId: 'other-option-3' },
  ]);
  assert.equal(restored.currentIndex, 1);
});

test('invalid, cross-attempt, and impossible local selections are ignored safely', () => {
  assert.equal(parseQuizDraft('{broken', 'attempt-1'), null);
  assert.equal(
    parseQuizDraft(
      JSON.stringify({
        attemptId: 'attempt-2',
        currentIndex: 0,
        answers: [],
      }),
      'attempt-1',
    ),
    null,
  );

  const restored = restoreQuizDraft('attempt-1', questions, {
    attemptId: 'attempt-1',
    currentIndex: 99,
    answers: [
      { questionId: 'question-2', optionId: 'not-in-snapshot' },
      { questionId: 'unknown-question', optionId: 'option-2' },
    ],
  });

  assert.deepEqual(restored.answers, [
    { questionId: 'question-1', optionId: 'server-option-1' },
    { questionId: 'question-3', optionId: 'server-option-3' },
  ]);
  assert.equal(restored.currentIndex, 1);
});

test('storage backup records the complete local draft and tolerates unavailable storage', () => {
  const values = new Map();
  const storage = {
    setItem(key, value) {
      values.set(key, value);
    },
  };
  assert.equal(
    writeQuizDraft(storage, 'attempt-1', [{ questionId: 'question-2', optionId: 'option-2' }], 1),
    true,
  );
  const stored = JSON.parse(values.get(quizDraftStorageKey('attempt-1')));
  assert.deepEqual(stored.answers, [{ questionId: 'question-2', optionId: 'option-2' }]);

  assert.equal(
    writeQuizDraft(
      {
        setItem: () => {
          throw new Error('quota');
        },
      },
      'attempt-1',
      [],
      0,
    ),
    false,
  );
});
