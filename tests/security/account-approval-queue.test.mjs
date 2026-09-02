import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('manual account approval uses a narrow, idempotent, capability-gated queue', async () => {
  const [migration, queueFix, submissionFix, sql, regressions, route, data, page, queue] =
    await Promise.all([
      read('supabase/migrations/20260831112000_admin_account_approval_queue.sql'),
      read('supabase/migrations/20260831117000_account_approval_queue_cursor_receipt_expiry.sql'),
      read('supabase/migrations/20260831118000_profile_approval_lock_order.sql'),
      read('supabase/tests/account_approval_queue.sql'),
      read('supabase/tests/account_approval_queue_regressions.sql'),
      read('app/api/admin/account-approvals/[userId]/route.ts'),
      read('features/admin/data.ts'),
      read('app/(admin)/admin/approvals/page.tsx'),
      read('components/admin/account-approval-queue.tsx'),
    ]);

  assert.match(migration, /create table private\.account_approval_decision_receipts/);
  assert.match(migration, /create function public\.list_pending_account_approval_page/);
  assert.match(migration, /private\.require_capability\('identity\.manage'\)/);
  assert.match(migration, /control\.approval_state = 'pending'/);
  assert.match(migration, /create function public\.decide_account_approval/);
  assert.match(migration, /private\.enforce_actor_quota\('admin\.identity\.mutate'\)/);
  assert.match(migration, /for update/);
  assert.match(migration, /IDEMPOTENCY_KEY_REUSED/);
  assert.match(migration, /ACCOUNT_APPROVAL_SELF_DECISION_FORBIDDEN/);
  assert.match(migration, /insert into public\.admin_audit_log/);
  assert.match(migration, /approval_state = v_decision::public\.account_approval_state/);
  assert.doesNotMatch(migration, /correctOptionId|test_revision_variant_answer_keys/);

  assert.match(queueFix, /create or replace function public\.list_pending_account_approval_page/);
  assert.match(queueFix, /select count\(\*\) > v_limit from candidates/);
  assert.match(queueFix, /from visible last_visible/);
  assert.match(queueFix, /order by last_visible\.approval_due_at desc, last_visible\.user_id desc/);
  assert.doesNotMatch(queueFix, /next_item as materialized/);
  assert.match(queueFix, /create or replace function public\.decide_account_approval/);
  assert.match(queueFix, /for update;/);
  assert.match(queueFix, /v_receipt\.expires_at <= statement_timestamp\(\)/);
  assert.match(queueFix, /delete from private\.account_approval_decision_receipts receipt/);
  assert.match(
    queueFix,
    /receipt\.actor_user_id = v_actor_id\s+and receipt\.idempotency_key = p_idempotency_key/,
  );
  assert.match(queueFix, /v_receipt := null;[\s\S]*select \* into v_receipt/);

  const controlLock = submissionFix.indexOf('select control.* into v_control');
  const profileLock = submissionFix.indexOf('select profile.* into v_profile');
  assert.ok(
    controlLock >= 0 && profileLock > controlLock,
    'account_controls must lock before profiles',
  );
  assert.match(submissionFix, /select control\.\* into v_control[\s\S]*?for update;/);
  assert.match(submissionFix, /select profile\.\* into v_profile[\s\S]*?for update;/);

  assert.match(sql, /approval queue grant boundary invalid/);
  assert.match(sql, /private\.require_capability\(''identity\.manage''\)/);
  assert.match(sql, /account_approval_not_pending/);
  assert.match(sql, /select count\(\*\) > v_limit from candidates/);
  assert.match(sql, /profile approval submission lock order invalid/);

  assert.match(regressions, /Four\s+-- pending learners with a page size of two/s);
  assert.match(regressions, /public\.list_pending_account_approval_page\(2, null, null\)/);
  assert.match(regressions, /v_queue_user_c/);
  assert.match(regressions, /v_queue_user_d/);
  assert.match(regressions, /Do not call the scheduled pruning RPC/);
  assert.match(regressions, /v_other_expired_key/);
  assert.match(regressions, /fresh receipt was not replayed after live reread/);

  assert.match(route, /invalidOriginResponse/);
  assert.match(route, /requireCapability\('identity\.manage'\)/);
  assert.match(route, /consumeAdminMutationQuota\(\s*'admin\.identity\.mutate'/);
  assert.match(route, /createClient/);
  assert.doesNotMatch(route, /createAdminClient/);
  assert.match(route, /decide_account_approval/);

  assert.match(data, /list_pending_account_approval_page/);
  assert.match(data, /getPendingAccountApprovalPage/);
  assert.match(page, /<AccountApprovalQueue/);
  assert.match(queue, /crypto\.randomUUID\(\)/);
  assert.match(queue, /Вернуть на уточнение/);
  assert.match(queue, /Подтвердить доступ/);
});

test('learner-facing course and profile UI block material until approval', async () => {
  const [topicPage, actions, status] = await Promise.all([
    read('app/(public)/topics/[slug]/page.tsx'),
    read('components/topics/course-material-actions.tsx'),
    read('features/profile/account-approval-status.tsx'),
  ]);

  assert.match(topicPage, /getAuthContext/);
  assert.match(topicPage, /auth\.approval\.state/);
  assert.match(actions, /pending: \{ title: t\('access\.pendingTitle'\)/);
  assert.match(actions, /description: t\('access\.pendingDescription'\)/);
  assert.match(actions, /access === 'approved'/);
  assert.match(status, /window\.setInterval/);
  assert.match(status, /<ContactLink\s+kind="phone"\s+contacts=\{contacts\}/);
  assert.match(status, /<ContactLink\s+kind="whatsapp"\s+contacts=\{contacts\}/);
});

test('minimal ZH applications expose a username only in the existing approval queue', async () => {
  const [migration, sql, queue, data] = await Promise.all([
    read('supabase/migrations/20260902150000_zh_minimal_pending_approval.sql'),
    read('supabase/tests/zh_minimal_pending_approval.sql'),
    read('components/admin/account-approval-queue.tsx'),
    read('features/admin/data.ts'),
  ]);

  assert.match(
    migration,
    /create function private\.add_zh_username_to_pending_approval_items\(p_payload jsonb\)/u,
  );
  assert.match(
    migration,
    /revoke all on function private\.add_zh_username_to_pending_approval_items/u,
  );
  assert.match(
    migration,
    /private\.add_zh_username_to_pending_approval_items\([\s\S]*?private\.redact_zh_email_items/u,
  );
  assert.match(migration, /private\.list_pending_account_approval_page_provider_internal/u);
  assert.doesNotMatch(
    migration,
    /create or replace function private\.emit_approval_requested_notification/u,
  );
  assert.match(sql, /v_event_payload \? 'username'/u);
  assert.match(sql, /v_queue_item ->> 'username' <> 'zhminimal001'/u);
  assert.match(queue, /accountIdentifier/u);
  assert.match(queue, /Логин: \$\{item\.username\}/u);
  assert.match(data, /username: z[\s\S]*?\.regex/u);
});
