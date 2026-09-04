import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('admin inbox stays behind a same-origin capability-gated API', async () => {
  const [server, listRoute, readRoute, retryRoute, contract] = await Promise.all([
    read('features/admin/notifications.ts'),
    read('app/api/admin/notifications/route.ts'),
    read('app/api/admin/notifications/read/route.ts'),
    read('app/api/admin/notifications/[eventId]/retry/route.ts'),
    read('features/admin/notification-contract.ts'),
  ]);

  assert.match(server, /requireCapability\('audit\.read'\)/u);
  assert.match(server, /list_admin_notification_inbox/u);
  assert.match(server, /mark_admin_notifications_read/u);
  assert.match(server, /retry_admin_notification_delivery/u);
  assert.match(server, /requestedLimit \+ 1/u);
  assert.match(server, /items\.slice\(0, requestedLimit\)/u);

  assert.match(listRoute, /createApiResponse\(null, \{ status: 304/u);
  assert.match(listRoute, /request\.headers\.get\('if-none-match'\) === etag/u);
  assert.match(listRoute, /ETag: etag/u);
  assert.match(listRoute, /Vary: 'Cookie'/u);
  assert.match(readRoute, /invalidOriginResponse\(request\)/u);
  assert.match(retryRoute, /invalidOriginResponse\(request\)/u);
  assert.match(readRoute, /eventIds: z\.array\(z\.string\(\)\.uuid\(\)\)\.min\(1\)\.max\(100\)/u);
  assert.match(readRoute, /consumeAdminMutationQuota/u);
  assert.match(retryRoute, /consumeAdminMutationQuota/u);

  for (const type of ['account.approval_requested', 'course.completed', 'system.alert']) {
    assert.match(contract, new RegExp(`z\\.literal\\('${type.replace('.', '\\.')}\\'\\)`));
  }
  assert.match(contract, /\.strict\(\)/u);
  assert.match(contract, /phoneCountryIso2/u);
  assert.match(contract, /phoneE164/u);
  assert.match(contract, /schemaVersion: z\.literal\(2\)/u);
  assert.match(contract, /name: z\.literal\(''\)/u);
  assert.doesNotMatch(
    contract,
    /\b(?:email|username|document|answer|credential|recovery|synthetic)\b/iu,
  );
  assert.doesNotMatch(server, /createAdminClient|createBrowserClient/u);
});

test('one provider polls the two responsive inbox controls without amplification', async () => {
  const [component, layout, approvalQueue] = await Promise.all([
    read('components/admin/admin-notification-inbox.tsx'),
    read('app/(admin)/admin/layout.tsx'),
    read('components/admin/account-approval-queue.tsx'),
  ]);

  assert.match(component, /const POLL_INTERVAL_MS = 60_000/u);
  assert.match(component, /const MAX_BACKOFF_MS = 120_000/u);
  assert.match(component, /document\.visibilityState === 'visible'/u);
  assert.match(component, /navigator\.onLine !== false/u);
  assert.match(component, /new AbortController\(\)/u);
  assert.match(component, /'If-None-Match'/u);
  assert.match(component, /POLL_INTERVAL_MS \* 2 \*\* consecutiveFailures/u);
  assert.match(component, /beforeOccurredAt: cursor\.occurredAt/u);
  assert.match(component, /beforeId: cursor\.id/u);
  assert.match(component, /Показать предыдущие/u);
  assert.match(component, /window\.addEventListener\(ADMIN_NOTIFICATION_REFRESH_EVENT/u);
  assert.match(component, /window\.addEventListener\('online'/u);
  assert.match(component, /window\.addEventListener\('offline'/u);
  assert.match(component, /Новая заявка ·/u);
  assert.doesNotMatch(component, /createBrowserClient|@\/lib\/supabase\/client/u);

  assert.equal((layout.match(/<AdminNotificationInboxProvider/u) ?? []).length, 1);
  assert.equal((layout.match(/<AdminNotificationInboxButton/gu) ?? []).length, 2);
  assert.match(layout, /actor\.capabilities\.includes\('audit\.read'\)/u);
  assert.match(approvalQueue, /requestAdminNotificationRefresh\(\)/u);
});
