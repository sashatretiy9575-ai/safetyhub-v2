import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('new approval notifications are generic no-PII v2 while legacy payload parsers remain bounded', async () => {
  const [legacyMigration, migration, dispatcher, documentation, serializationMigration] =
    await Promise.all([
      read('supabase/migrations/20260902110000_capacity_telegram_application_details.sql'),
      read('supabase/migrations/20260902180000_generic_approval_notifications.sql'),
      read('supabase/functions/telegram-dispatcher/index.ts'),
      read('docs/notifications-and-telegram.md'),
      read('supabase/migrations/20260902140000_runtime_feature_flag_serialization.sql'),
    ]);

  assert.match(legacyMigration, /'telegram_application_details', false/u);
  assert.match(
    legacyMigration,
    /p_feature_name = 'telegram_application_details'[\s\S]*?TELEGRAM_DELIVERY_MUST_BE_ENABLED_FIRST/u,
  );
  assert.match(legacyMigration, /TELEGRAM_APPLICATION_DETAILS_MUST_BE_DISABLED_FIRST/u);
  assert.match(migration, /'schemaVersion', 2/u);
  assert.match(migration, /recover_legacy_blank_zh_approval_deliveries/u);
  assert.match(
    migration,
    /delivery\.status = 'dead'[\s\S]*?remote_message_id is null[\s\S]*?lease_token is null/u,
  );
  const v2Trigger =
    migration.match(
      /create or replace function private\.emit_approval_requested_notification\(\)([\s\S]*?)\$\$;/u,
    )?.[1] ?? '';
  assert.match(
    v2Trigger,
    /jsonb_build_object\([\s\S]*?'schemaVersion', 2[\s\S]*?'locale'[\s\S]*?'requestedAt'[\s\S]*?'adminPath'/u,
  );
  for (const field of ['job', 'organization', 'phoneCountryIso2', 'phoneE164']) {
    assert.match(dispatcher, new RegExp("'" + field + "'", 'u'));
    assert.doesNotMatch(v2Trigger, new RegExp("'" + field + "'", 'u'));
  }
  assert.doesNotMatch(
    v2Trigger,
    /v_include_application_details|TELEGRAM_APPLICATION_DETAILS_INCOMPLETE/u,
  );
  assert.match(
    serializationMigration,
    /pg_advisory_xact_lock\(hashtextextended\('safetyhub\.runtime_feature_flags\.v1', 0\)\);[\s\S]*?pg_advisory_xact_lock\(hashtextextended\(p_idempotency_key::text, 0\)\);/u,
  );
  assert.match(dispatcher, /exactKeys\([\s\S]*?'phoneE164'/u);
  assert.match(dispatcher, /approvalKind: 'generic_v2'/u);
  assert.match(dispatcher, /approvalKind: 'legacy_blank_zh'/u);
  assert.match(dispatcher, /function parseLeaseClaim/u);
  assert.doesNotMatch(dispatcher, /reply_markup|callback_query|bot_command/iu);
  assert.match(documentation, /telegram_application_details/u);
  assert.match(documentation, /schema-v2 generic envelope/u);
  assert.match(documentation, /dead → retry → delivered/u);
});

test('prototype capacity monitor remains aggregate-only, bounded, service-only, and alert-only', async () => {
  const [migration, worker, appTypes, generatedTypes, operations] = await Promise.all([
    read('supabase/migrations/20260902110000_capacity_telegram_application_details.sql'),
    read('supabase/functions/storage-reconciler/index.ts'),
    read('lib/supabase/types.ts'),
    read('lib/supabase/database.generated.ts'),
    read('docs/operations.md'),
  ]);

  assert.match(migration, /create table private\.capacity_monitor_snapshots/u);
  assert.match(migration, /create table private\.capacity_monitor_alert_state/u);
  assert.match(migration, /monthly_active_learner_limit integer not null default 100/u);
  assert.match(migration, /warning_percent smallint not null default 70/u);
  assert.match(migration, /action_percent smallint not null default 85/u);
  assert.match(migration, /critical_percent smallint not null default 95/u);
  assert.match(migration, /at most one[\s\S]{0,40}daily row in Asia\/Oral/u);
  assert.match(migration, /select cron\.schedule\([\s\S]*?'safetyhub-capacity-monitor'/u);
  assert.match(
    migration,
    /revoke all on function public\.collect_capacity_monitor_snapshot\(boolean\)/u,
  );
  assert.match(
    migration,
    /grant execute on function public\.collect_capacity_monitor_snapshot\(boolean\)[\s\S]*?to service_role/u,
  );
  assert.match(worker, /rpc\(client, 'collect_capacity_monitor_snapshot', \{ p_force: false \}\)/u);
  assert.match(worker, /rpc\(client, 'prune_certificate_export_jobs', \{ p_limit: 500 \}\)/u);
  assert.match(appTypes, /collect_capacity_monitor_snapshot:/u);
  assert.match(appTypes, /set_capacity_monitor_monthly_active_learner_budget:/u);
  assert.match(generatedTypes, /collect_capacity_monitor_snapshot:/u);
  assert.match(operations, /It is not a\r?\n+signup, approval or learning-access cap/u);
});
