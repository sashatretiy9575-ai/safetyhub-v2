import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  validateAssessment,
  assessmentProjection,
  COURSE_BATCH_SLUGS,
  COURSE_BATCH_LOCALES,
} from '../../scripts/content/publish-course-batch.mjs';

function bank() {
  return Array.from({ length: 3 }, (_, v) => ({
    id: randomUUID(),
    variantNumber: v + 1,
    questions: Array.from({ length: 10 }, (_, q) => {
      const options = Array.from({ length: 4 }, (_, o) => ({
        id: randomUUID(),
        text: `Ответ ${o + 1}`,
        displayOrder: o + 1,
      }));
      return {
        id: randomUUID(),
        text: `Проверяемый вопрос номер ${v * 10 + q + 1}`,
        options,
        correctOptionId: options[0].id,
        explanation: 'Пояснение подтверждается учебным материалом.',
      };
    }),
  }));
}

test('new batch includes exactly the two authorized courses and four existing locales', () => {
  assert.deepEqual(COURSE_BATCH_SLUGS, ['svarshchik', 'promyshlennaya-bezopasnost']);
  assert.deepEqual(COURSE_BATCH_LOCALES, ['ru', 'kk', 'en', 'zh']);
});
test('localization cannot change a correct answer or assessment identity', () => {
  const source = bank(),
    translated = structuredClone(source);
  validateAssessment(translated, source);
  translated[1].questions[2].correctOptionId = translated[1].questions[2].options[2].id;
  assert.throws(() => validateAssessment(translated, source), /TRANSLATION_ANSWER_MISMATCH/);
});
test('invalid bank and ambiguous identical options cannot be published', () => {
  const source = bank();
  source[0].questions[0].options[1].text = source[0].questions[0].options[0].text;
  assert.throws(() => validateAssessment(source), /ASSESSMENT_OPTIONS_INVALID/);
});

test('Chinese question length supports concise complete questions without weakening other locales', () => {
  const source = bank();
  source[0].questions[0].text = '如何移动气瓶？';
  validateAssessment(source, null, 'zh');
  assert.throws(() => validateAssessment(source, null, 'ru'), /ASSESSMENT_TEXT_INVALID/);
  source[0].questions[0].text = '？';
  assert.throws(() => validateAssessment(source, null, 'zh'), /ASSESSMENT_TEXT_INVALID/);
});
test('localization import projection never contains answer keys or editorial source notes', () => {
  const source = bank();
  source[0].questions[0].slideRefs = ['slide-1'];
  const projected = assessmentProjection(source);
  assert.equal(JSON.stringify(projected).includes('correctOptionId'), false);
  assert.equal(JSON.stringify(projected).includes('slideRefs'), false);
  assert.equal(
    assessmentProjection(source, true)[0].questions[0].correctOptionId,
    source[0].questions[0].correctOptionId,
  );
});
