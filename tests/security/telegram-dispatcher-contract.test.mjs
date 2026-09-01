import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('Telegram dispatcher is bearer-protected, bounded, leased, and service-only', async () => {
  const [source, config] = await Promise.all([
    read('supabase/functions/telegram-dispatcher/index.ts'),
    read('supabase/config.toml'),
  ]);

  for (const secret of [
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'TELEGRAM_DISPATCHER_SECRET',
    'SAFETYHUB_SITE_URL',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]) {
    assert.match(source, new RegExp(`requiredEnv\\('${secret}'\\)`));
  }
  assert.match(source, /constantTimeEqual\(token, dispatcherSecret\)/u);
  assert.match(source, /const CLAIM_LIMIT = 12/u);
  assert.match(source, /const CLAIM_LEASE_SECONDS = 45/u);
  assert.match(source, /const SEND_CONCURRENCY = 3/u);
  assert.match(source, /const TELEGRAM_TIMEOUT_MS = 8_000/u);
  assert.match(source, /MAX_RESPONSE_BYTES/u);
  assert.match(source, /claim_notification_deliveries/u);
  assert.match(source, /complete_notification_delivery/u);
  assert.match(source, /fail_notification_delivery/u);
  assert.match(source, /prune_notification_data/u);
  assert.match(source, /p_lease_token: claim\.leaseToken/u);
  assert.match(source, /body\.parameters\.retry_after/u);
  assert.match(source, /TELEGRAM_RATE_LIMITED/u);
  assert.match(source, /cache-control': 'no-store'/u);
  assert.match(config, /\[functions\.telegram-dispatcher\]\s*\r?\nverify_jwt = false/u);
});

test('Telegram templates allow exactly three minimized informational events', async () => {
  const source = await read('supabase/functions/telegram-dispatcher/index.ts');
  const typeBlock =
    source.match(/const ALLOWED_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\);/u)?.[1] ?? '';
  const types = [...typeBlock.matchAll(/'([^']+)'/gu)].map((match) => match[1]);
  assert.deepEqual(types, ['account.approval_requested', 'course.completed', 'system.alert']);
  assert.match(source, /Нов(?:ая|ую) заявк/u);
  assert.match(source, /Курс пройден/u);
  assert.match(source, /Курс не пройден/u);
  assert.match(source, /Системное уведомление/u);
  assert.match(source, /Корреляция/u);
  assert.match(source, /link_preview_options: \{ is_disabled: true \}/u);
  assert.doesNotMatch(
    source,
    /\b(?:email|phone|job|organization|document|answer|credential|recovery|synthetic)\b/iu,
  );
  assert.doesNotMatch(source, /reply_markup|callback_query|bot_command/iu);
  assert.doesNotMatch(source, /console\.log/u);
  assert.doesNotMatch(source, /console\.error\([^\n]*(?:botToken|dispatcherSecret|chatId|text)/u);
});
