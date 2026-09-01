import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('full Telegram application details remain separately fail-closed and payload-bounded', async () => {
  const [migration, dispatcher, documentation, serializationMigration] = await Promise.all([
    read('supabase/migrations/20260902110000_capacity_telegram_application_details.sql'),
    read('supabase/functions/telegram-dispatcher/index.ts'),
    read('docs/notifications-and-telegram.md'),
    read('supabase/migrations/20260902140000_runtime_feature_flag_serialization.sql'),
  ]);

  assert.match(migration, /'telegram_application_details', false/u);
  assert.match(
    migration,
    /p_feature_name = 'telegram_application_details'[\s\S]*?TELEGRAM_DELIVERY_MUST_BE_ENABLED_FIRST/u,
  );
  assert.match(
    migration,
    /TELEGRAM_APPLICATION_DETAILS_MUST_BE_DISABLED_FIRST/u,
  );
  assert.match(
    migration,
    /v_include_application_details := private\.runtime_feature_enabled\([\s\S]*?'telegram_application_details'/u,
  );
  for (const field of ['job', 'organization', 'phoneCountryIso2', 'phoneE164']) {
    assert.match(migration, new RegExp(`'${field}'`, 'u'));
    assert.match(dispatcher, new RegExp(`'${field}'`, 'u'));
  }
  assert.match(migration, /TELEGRAM_APPLICATION_DETAILS_INCOMPLETE/u);
  assert.match(
    serializationMigration,
    /pg_advisory_xact_lock\(hashtextextended\('safetyhub\.runtime_feature_flags\.v1', 0\)\);[\s\S]*?pg_advisory_xact_lock\(hashtextextended\(p_idempotency_key::text, 0\)\);/u,
  );
  assert.match(dispatcher, /exactKeys\([\s\S]*?'phoneE164'/u);
  assert.doesNotMatch(dispatcher, /reply_markup|callback_query|bot_command/iu);
  assert.match(documentation, /telegram_application_details/u);
  assert.match(
    documentation,
    /replacement strict message with exactly[\s\S]*?phoneCountryIso2[\s\S]*?phoneE164/u,
  );
  assert.match(
    documentation,
    /contains no locale, event time, correlation ID, admin deep[\s\S]*?email, username/u,
  );
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
  assert.match(migration, /revoke all on function public\.collect_capacity_monitor_snapshot\(boolean\)/u);
  assert.match(migration, /grant execute on function public\.collect_capacity_monitor_snapshot\(boolean\)[\s\S]*?to service_role/u);
  assert.match(worker, /rpc\(client, 'collect_capacity_monitor_snapshot', \{ p_force: false \}\)/u);
  assert.match(worker, /rpc\(client, 'prune_certificate_export_jobs', \{ p_limit: 500 \}\)/u);
  assert.match(appTypes, /collect_capacity_monitor_snapshot:/u);
  assert.match(appTypes, /set_capacity_monitor_monthly_active_learner_budget:/u);
  assert.match(generatedTypes, /collect_capacity_monitor_snapshot:/u);
  assert.match(operations, /It is not a\n+signup, approval or learning-access cap/u);
});
