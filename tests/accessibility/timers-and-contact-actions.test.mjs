import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('approval status uses a calm, minute-resolution status strip instead of nested timer cards', async () => {
  const [status, ruMessages] = await Promise.all([
    read('features/profile/account-approval-status.tsx'),
    read('messages/ru.json'),
  ]);
  const ru = JSON.parse(ruMessages);

  assert.match(status, /Math\.ceil\(milliseconds \/ 60_000\)/);
  assert.doesNotMatch(status, /setInterval\(/);
  assert.match(status, /syncAtMinuteBoundary/);
  assert.match(status, /role="timer"/);
  assert.match(status, /<time[\s\S]*?tabular-nums/);
  assert.match(status, /formatDueAt/);
  assert.match(status, /t\('deadline', \{ deadline: dueLabel \}\)/);
  assert.doesNotMatch(status, /<Card|<CardContent/);
  assert.equal(
    ru.Approval.countdownHint,
    'Время показано с точностью до минуты; обновлять страницу не нужно.',
  );
  assert.equal(ru.Approval.deadline, 'Контрольный срок: {deadline}');
});

test('quiz exposes one consistent fixed-width timer and accessible progress in question and review views', async () => {
  const [quiz, ruMessages] = await Promise.all([
    read('components/quiz/quiz-client.tsx'),
    read('messages/ru.json'),
  ]);
  const ru = JSON.parse(ruMessages);

  assert.match(quiz, /function AttemptTimer/);
  assert.match(quiz, /min-w-\[6\.25rem\]/);
  assert.match(quiz, /tabular-nums/);
  assert.match(quiz, /WarningCircle/);
  assert.match(quiz, /data-urgency=/);
  assert.match(quiz, /timerUrgentAria/);
  assert.match(quiz, /aria-label=\{t\('progressAria'/);
  assert.ok((quiz.match(/<AttemptTimer/g) ?? []).length >= 2);
  assert.ok((quiz.match(/<Progress/g) ?? []).length >= 2);
  assert.equal(ru.Quiz.timerUrgentAria, 'Осталось менее пяти минут: {time}');
  assert.equal(ru.Quiz.progressAria, 'Отвечено на {completed} из {total} вопросов');
});

test('WhatsApp contact actions use the shared brand-green token and retain explicit labels', async () => {
  const [contacts, legalContacts, approvalStatus, footer] = await Promise.all([
    read('components/shared/contact-actions.tsx'),
    read('components/legal/legal-contacts.tsx'),
    read('features/profile/account-approval-status.tsx'),
    read('components/layout/footer.tsx'),
  ]);

  for (const source of [contacts, legalContacts, approvalStatus, footer]) {
    assert.match(source, /var\(--color-primary\)/);
  }
  assert.doesNotMatch(contacts, /#128c4a|#25d366|#39dc7a/);
  assert.doesNotMatch(approvalStatus, /#128c4a|#39dc7a/);
  assert.match(contacts, /PhoneCall/);
  assert.match(contacts, /WhatsappLogo/);
  assert.match(contacts, /min-h-14/);
  assert.match(footer, /min-h-11/);
});
