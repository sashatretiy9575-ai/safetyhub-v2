import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../supabase/migrations/20260813070000_persistent_actor_quota.sql',
  import.meta.url,
);

const readMigration = () => readFile(migrationUrl, 'utf8');

function section(source, start, end) {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.ok(startAt >= 0, `missing section start: ${start}`);
  assert.ok(endAt > startAt, `missing section end: ${end}`);
  return source.slice(startAt, endAt);
}

test('Auth-admin prepare, claim, advance, and purge share one lock order', async () => {
  const migration = await readMigration();
  const sections = [
    section(
      migration,
      'create or replace function public.prepare_user_invite',
      'create or replace function public.request_account_suspension_confirmed',
    ),
    section(
      migration,
      'create or replace function public.request_account_suspension_confirmed',
      'create or replace function public.manage_user_role_confirmed',
    ),
    section(
      migration,
      'create or replace function public.claim_auth_admin_operation_confirmed',
      'create or replace function public.advance_auth_admin_operation',
    ),
    section(
      migration,
      'create or replace function public.advance_auth_admin_operation',
      'create function public.prune_terminal_auth_admin_outbox',
    ),
    section(
      migration,
      'create or replace function public.begin_user_account_purge',
      'create or replace function public.purge_user_account',
    ),
    section(
      migration,
      'create or replace function public.purge_user_account',
      'create or replace function public.resolve_certificate_export',
    ),
  ];

  for (const source of sections) {
    assert.match(source, /perform private\.lock_auth_admin_outbox\(\)/u);
  }

  for (const source of [sections[1], sections[3], sections[4], sections[5]]) {
    assert.ok(
      source.indexOf('private.lock_auth_admin_outbox()') <
        source.indexOf('private.lock_active_superadmin_invariant()'),
      'global outbox lock must precede the active-superadmin lock',
    );
  }
});

test('direct invite and suspension RPC inputs fail closed before durable work', async () => {
  const migration = await readMigration();
  const invite = section(
    migration,
    'create or replace function public.prepare_user_invite',
    'create or replace function public.request_account_suspension_confirmed',
  );
  const suspension = section(
    migration,
    'create or replace function public.request_account_suspension_confirmed',
    'create or replace function public.manage_user_role_confirmed',
  );

  for (const token of [
    'p_email is null',
    'p_name is null',
    'p_surname is null',
    'p_job is null',
    'p_password_ticket is null',
    'p_redirect_origin is null',
  ]) {
    assert.match(invite, new RegExp(token.replaceAll(' ', '\\s+'), 'u'));
  }
  assert.match(invite, /message = 'INVITE_INVALID'/u);
  assert.ok(
    invite.indexOf("message = 'INVITE_INVALID'") <
      invite.indexOf('private.prepare_user_invite_unmetered'),
  );
  assert.match(suspension, /p_target_id is null/u);
  assert.match(suspension, /p_suspended is null/u);
  assert.match(suspension, /p_reason is null/u);
  assert.match(
    suspension,
    /char_length\(private\.normalize_profile_text\(p_reason\)\) not between 10 and 500/u,
  );
  assert.match(suspension, /message = 'SUSPENSION_INVALID'/u);
  assert.ok(
    suspension.indexOf("message = 'SUSPENSION_INVALID'") <
      suspension.indexOf('private.request_account_suspension_confirmed_unmetered'),
  );
});

test('claims use expiring hashed completion tokens and recover invites by exact correlation', async () => {
  const migration = await readMigration();
  const claim = section(
    migration,
    'create or replace function public.claim_auth_admin_operation_confirmed',
    'create or replace function public.advance_auth_admin_operation',
  );
  const advance = section(
    migration,
    'create or replace function public.advance_auth_admin_operation',
    'create function public.prune_terminal_auth_admin_outbox',
  );

  assert.match(migration, /add column if not exists processing_lease_expires_at timestamptz/u);
  assert.match(claim, /processing_lease_expires_at > statement_timestamp\(\)/u);
  assert.match(claim, /message = 'OUTBOX_ALREADY_CLAIMED'/u);
  assert.match(claim, /extensions\.gen_random_bytes\(32\)/u);
  assert.match(claim, /extensions\.digest\(convert_to\(v_token, 'utf8'\), 'sha256'\)/u);
  assert.match(
    claim,
    /processing_lease_expires_at = statement_timestamp\(\) \+ interval '5 minutes'/u,
  );
  assert.match(
    claim,
    /lower\(btrim\(auth_user\.email\)\)[\s\S]*lower\(btrim\(v_operation\.payload ->> 'email'\)\)/u,
  );
  assert.match(claim, /safetyhubInviteCorrelation[\s\S]*inviteCorrelation/u);
  assert.match(claim, /if v_recovery_count > 1/u);
  assert.match(claim, /message = 'OUTBOX_INVITE_RECOVERY_AMBIGUOUS'/u);

  assert.match(advance, /v_operation\.completion_token_hash <> v_expected/u);
  assert.match(advance, /message = 'OUTBOX_TOKEN_INVALID'/u);
  assert.match(advance, /processing_lease_expires_at <= statement_timestamp\(\)/u);
  assert.match(advance, /message = 'OUTBOX_LEASE_EXPIRED'/u);
  assert.match(advance, /v_operation\.state in \('committed', 'rolled_back', 'failed'\)/u);
  assert.match(advance, /message = 'OUTBOX_TRANSITION_INVALID'/u);
});

test('suspension stays fail-closed until external success is committed', async () => {
  const migration = await readMigration();
  const prepare = section(
    migration,
    'create or replace function public.request_account_suspension_confirmed',
    'create or replace function public.manage_user_role_confirmed',
  );
  const advance = section(
    migration,
    'create or replace function public.advance_auth_admin_operation',
    'create function public.prune_terminal_auth_admin_outbox',
  );

  const localSuspendAt = prepare.indexOf("set status = 'suspended'");
  const operationAt = prepare.indexOf('private.request_account_suspension_confirmed_unmetered');
  assert.ok(localSuspendAt >= 0 && operationAt > localSuspendAt);
  assert.match(
    advance,
    /elsif v_operation\.operation_type in \('suspend', 'restore'\) then[\s\S]*set status = 'suspended'/u,
  );
  assert.match(
    advance,
    /set status = case when v_operation\.operation_type = 'suspend'[\s\S]*else 'active'::public\.account_status end/u,
  );
  assert.match(advance, /where user_id = v_target_id and not deletion_pending/u);
});

test('terminal outbox rows discard PII and pruning never removes nonterminal work', async () => {
  const migration = await readMigration();
  const advance = section(
    migration,
    'create or replace function public.advance_auth_admin_operation',
    'create function public.prune_terminal_auth_admin_outbox',
  );
  const prune = section(
    migration,
    'create function public.prune_terminal_auth_admin_outbox',
    '-- Audit records linked to a user',
  );

  assert.match(
    advance,
    /v_sanitized_payload := jsonb_strip_nulls\(jsonb_build_object\([\s\S]*'targetId'[\s\S]*'requestedRole'/u,
  );
  assert.match(advance, /payload = v_sanitized_payload/u);
  assert.match(advance, /last_error = case when p_state = 'committed'[\s\S]*v_error_category/u);
  assert.doesNotMatch(
    advance.match(/v_sanitized_payload :=[\s\S]*?\);/u)?.[0] ?? '',
    /email|name|surname|job|reason|password|ticket|redirect|_audit/iu,
  );
  assert.match(prune, /operation\.state in \('committed', 'rolled_back', 'failed'\)/u);
  assert.match(prune, /operation\.updated_at < statement_timestamp\(\) - interval '90 days'/u);
  assert.doesNotMatch(prune, /'prepared'|'external_succeeded'|'retryable'/u);
  assert.match(prune, /for update skip locked/u);
});

test('account purge has an exact indexed path for outbox-linked immutable audit', async () => {
  const migration = await readMigration();

  assert.match(
    migration,
    /create index admin_audit_auth_operation_target_idx\s+on public\.admin_audit_log \(target_id\)\s+where target_type = 'auth_admin_operation'/u,
  );
  assert.match(
    migration,
    /delete from public\.admin_audit_log audit[\s\S]*audit\.target_type = 'auth_admin_operation'[\s\S]*audit\.target_id = any\(\s*array\(select operation_id::text from unnest\(v_operation_ids\) operation_id\)\s*\)/u,
  );
});
