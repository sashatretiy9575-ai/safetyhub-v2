import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';
import { Client as PostgresClient } from 'pg';
import {
  assertCleanLoadTestBaseline,
  assertDisposableProjectMarker,
  assertLocalCiCleanLoadTestBaseline,
  assertLocalCiLoadTestTarget,
  assertLoadTestTarget,
} from './load-test-safety.mjs';

const MAX_MAU_PROFILE = 100;
const DEFAULT_USER_COUNT = MAX_MAU_PROFILE;
const DEFAULT_SESSION_COUNT = 100;
const LOAD_WAVES = [25, 50, 100];
const APP_LOCALES = ['ru', 'kk', 'en', 'zh'];
const ROW_CHUNK = 400;
const PREPARATION_RETRY_LIMIT = 5;
const PREPARATION_CONCURRENCY = 4;
// Cloudflare's documented public dummy response is accepted only by the
// disposable local CI Auth container, whose secret is the matching test key.
// It is never used for hosted load targets or application requests.
const LOCAL_CI_TURNSTILE_DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const TRANSIENT_NETWORK_ERROR =
  /fetch failed|network|econnreset|etimedout|socket hang up|und_err|http 50[234]|temporarily unavailable|connection (?:terminated|reset)/iu;

function parseEnvFile(source) {
  return Object.fromEntries(
    source
      .split(/\r?\n/u)
      .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/u.test(line))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

async function loadEnvironment() {
  // Local CI credentials are exported by `supabase status`; never let a
  // developer file override or supplement that isolated trust boundary.
  if (process.env.SAFETYHUB_LOAD_TARGET === 'local-ci') return;

  let source;
  try {
    source = await readFile('.env.local', 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const local = parseEnvFile(source);
  for (const key of [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_SECRET_KEY',
  ]) {
    if (!process.env[key] && local[key]) process.env[key] = local[key];
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name, fallback, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function percentile(values, percentileValue) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * ordered.length) - 1),
  );
  return Number(ordered[index].toFixed(1));
}

function assertNoForbiddenLearnerKeys(value, context) {
  const forbidden = new Set([
    'variantid',
    'variantnumber',
    'correctoption',
    'correctoptionid',
    'iscorrect',
    'answerkey',
  ]);
  const visit = (candidate) => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    for (const [key, nested] of Object.entries(candidate)) {
      if (forbidden.has(key.replace(/[^a-z]/giu, '').toLowerCase())) {
        throw new Error(`${context}: forbidden learner key ${key}`);
      }
      visit(nested);
    }
  };
  visit(value);
}

function notificationClaims(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.items)) {
    throw new Error('claim_notification_deliveries: invalid response');
  }
  return value.items;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function mapLimit(items, concurrency, operation) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        output[index] = await operation(items[index], index);
      }
    }),
  );
  return output;
}

async function createLoadTestUser(createUser, getUserById, { id, email }, index) {
  for (let attempt = 1; attempt <= PREPARATION_RETRY_LIMIT; attempt += 1) {
    const result = await createUser();
    if (!result.error) {
      if (result.data.user.id !== id || result.data.user.email !== email) {
        throw new Error(`createUser ${index + 1}: deterministic identity mismatch`);
      }
      return { id, email };
    }

    // A network failure can occur after GoTrue committed the user but before
    // the response reached this process. Confirm the deterministic id before
    // retrying so preparation remains idempotent and does not add orphan users.
    const existing = await getUserById();
    if (!existing.error && existing.data.user?.email === email) return { id, email };

    const message = result.error.message ?? String(result.error);
    if (!TRANSIENT_NETWORK_ERROR.test(message) || attempt === PREPARATION_RETRY_LIMIT) {
      throw new Error(`createUser ${index + 1}: AUTH_ADMIN_CREATE_FAILED`);
    }
    await wait(250 * 2 ** (attempt - 1));
  }

  throw new Error(`createUser ${index + 1}: retry limit exhausted`);
}

function chunks(items, size = ROW_CHUNK) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function rpcData(client, name, args) {
  const result = await client.rpc(name, args);
  if (result.error) throw new Error(`${name}: ${result.error.message}`);
  return result.data;
}

async function insertChunks(client, table, rows, options = {}) {
  for (const batch of chunks(rows)) {
    const query = options.upsert
      ? client.from(table).upsert(batch, { onConflict: options.onConflict })
      : client.from(table).insert(batch);
    const { error } = await query;
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

function buildProfile(user, index, timestamp) {
  const organizationIndex = (index % 20) + 1;
  return {
    id: user.id,
    name: `Ученик ${String(index + 1).padStart(4, '0')}`,
    surname: `Тестовый ${String((index % 200) + 1).padStart(3, '0')}`,
    job: index % 3 === 0 ? 'Инженер по безопасности' : 'Специалист',
    organization: `ТОО Нагрузочная компания ${String(organizationIndex).padStart(2, '0')}`,
    phone_country_iso2: 'KZ',
    phone_e164: `+7701${String(index + 1).padStart(7, '0')}`,
    onboarding_completed_at: timestamp,
    // start_test_attempt_unmetered requires avatar_updated_at for every
    // learner, ZH included, since 20260903120000_zh_full_profile_admission
    // removed the bypass that let a ZH account skip it. This is the first run
    // ever to reach that check with a real course to attempt (pozharnaya-
    // bezopasnost had no published revision before this session), so nothing
    // caught it until now. buildProfileAvatarManifest below provisions the
    // matching legacy_imported manifest row.
    avatar_updated_at: timestamp,
  };
}

function boundedAuthErrorEvidence(error) {
  const status = Number(error?.status);
  const statusCategory =
    Number.isInteger(status) && status >= 400 && status <= 599 ? String(status) : 'UNKNOWN';
  const rawCode = typeof error?.code === 'string' ? error.code.toLowerCase() : '';
  const codeCategory = /^[a-z0-9_]{1,64}$/u.test(rawCode) ? rawCode.toUpperCase() : 'UNKNOWN';
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  const failureCategory = /zh_username_password_required|username_password_required/u.test(message)
    ? 'ZH_USERNAME_PASSWORD_REQUIRED'
    : /access token hook|auth hook|hook/u.test(message)
      ? 'ACCESS_TOKEN_HOOK'
      : /rate|too many/u.test(message)
        ? 'RATE_LIMIT'
        : /expired|invalid.*(?:token|link)|token.*invalid/u.test(message)
          ? 'TOKEN_REJECTED'
          : /database/u.test(message)
            ? 'DATABASE'
            : 'OTHER';
  return `HTTP_${statusCategory}_CODE_${codeCategory}_CATEGORY_${failureCategory}`;
}

function createZhLoadTestUsername() {
  return `loadzh${crypto.randomBytes(12).toString('hex')}`;
}

function createZhLoadTestPassword() {
  // The password is process-local, goes only to GoTrue, and is intentionally
  // absent from all progress, report, and failure output.
  return `LoadTest9-${crypto.randomBytes(24).toString('hex')}`;
}

async function createZhLoadTestUser(admin, index, legal) {
  const id = crypto.randomUUID();
  const email = `${crypto.randomBytes(16).toString('hex')}@auth.invalid`;
  const username = createZhLoadTestUsername();
  const password = createZhLoadTestPassword();

  const user = await createLoadTestUser(
    () =>
      admin.auth.admin.createUser({
        id,
        email,
        password,
        email_confirm: true,
        app_metadata: {
          safetyhub_auth_kind: 'zh_username_password',
        },
        user_metadata: { preferred_locale: 'zh', safetyhub_load_test: true },
      }),
    () => admin.auth.admin.getUserById(id),
    { id, email },
    index,
  );
  const completed = await timedRpc(admin, 'complete_zh_username_registration', {
    p_user_id: user.id,
    p_username: username,
    p_synthetic_email: email,
    p_privacy_version: legal.privacy.version,
    p_privacy_body_revision: legal.privacy.bodyRevision,
    p_terms_version: legal.terms.version,
    p_terms_body_revision: legal.terms.bodyRevision,
  });
  // Registration is no longer the application: since
  // 20260903120000_zh_full_profile_admission it leaves the account at
  // profile_incomplete, and the learner reaches pending by submitting the same
  // form as every other locale.
  if (completed.data?.userId !== user.id || completed.data?.approvalState !== 'profile_incomplete') {
    throw new Error(`zh username registration ${index + 1}: COMPLETION_CONTRACT_MISMATCH`);
  }

  const mapping = await timedRpc(admin, 'get_zh_username_login_mapping', {
    p_username: username,
  });
  if (mapping.data?.userId !== user.id || mapping.data?.syntheticEmail !== email) {
    throw new Error(`zh username registration ${index + 1}: LOGIN_MAPPING_CONTRACT_MISMATCH`);
  }

  return {
    ...user,
    username,
    password,
    profile: buildProfile(user, index, new Date().toISOString()),
    registrationMetrics: {
      completeMs: completed.duration,
      mappingMs: mapping.duration,
    },
  };
}

function buildSyntheticDomainData(users, revisions, timestamp) {
  const attempts = [];
  const attestations = [];
  const completedBase = Date.parse(timestamp) - 20 * 24 * 60 * 60 * 1_000;

  users.forEach((user, userIndex) => {
    revisions.forEach((revision, revisionIndex) => {
      const variants = Array.isArray(revision.variants) ? revision.variants : [];
      if (variants.length === 0) {
        throw new Error(`${revision.slug}: published revision has no assessment variant`);
      }
      const worstWindow = userIndex >= users.length - 100 && revisionIndex === 0;
      const attemptCount = worstWindow ? 6 : 1 + ((userIndex + revisionIndex) % 2);
      const candidates = [];

      for (let attemptIndex = 0; attemptIndex < attemptCount; attemptIndex += 1) {
        const id = crypto.randomUUID();
        const variant = variants[(userIndex + attemptIndex) % variants.length];
        const score =
          (userIndex + revisionIndex + attemptIndex * 2) % (revision.question_count + 1);
        const completedAt = new Date(
          completedBase +
            ((userIndex * 17 + revisionIndex * 5 + attemptIndex) % 19) * 24 * 60 * 60 * 1_000 +
            attemptIndex * 60_000,
        ).toISOString();
        const startedAt = new Date(Date.parse(completedAt) - 4 * 60_000).toISOString();
        attempts.push({
          id,
          user_id: user.id,
          test_id: revision.test_id,
          revision_id: revision.id,
          variant_id: variant.id,
          duration_minutes: revision.duration_minutes,
          pass_score: revision.pass_score,
          attempts_per_day: revision.attempts_per_calendar_day,
          reset_timezone: revision.attempt_reset_timezone,
          status: score >= revision.pass_score ? 'passed' : 'failed',
          answers: Array.from({ length: revision.question_count }, () => 0),
          score,
          started_at: startedAt,
          expires_at: new Date(
            Date.parse(startedAt) + revision.duration_minutes * 60_000,
          ).toISOString(),
          completed_at: completedAt,
        });
        candidates.push({ id, score, completedAt });
      }

      candidates.sort(
        (left, right) =>
          right.score - left.score ||
          right.completedAt.localeCompare(left.completedAt) ||
          right.id.localeCompare(left.id),
      );
      const best = candidates[0];
      attestations.push({
        id: crypto.randomUUID(),
        user_id: user.id,
        revision_id: revision.id,
        best_attempt_id: best.id,
        best_score: best.score,
        best_completed_at: best.completedAt,
        updated_at: timestamp,
      });
    });

  });

  return { attempts, attestations };
}

async function timedRpc(client, name, args) {
  const started = performance.now();
  const result = await client.rpc(name, args);
  const duration = performance.now() - started;
  if (result.error) throw new Error(`${name}: ${result.error.message}`);
  return { data: result.data, duration };
}

async function createAuthenticatedClient(url, publishableKey, user, captchaToken) {
  const client = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const started = performance.now();
    let signedIn;
    try {
      signedIn = await client.auth.signInWithPassword({
        email: user.email,
        password: user.password,
        options: captchaToken ? { captchaToken } : undefined,
      });
    } catch (error) {
      if (!TRANSIENT_NETWORK_ERROR.test(error?.message ?? String(error)) || attempt === 8) {
        throw new Error(`ZH_PASSWORD_SIGN_IN_FAILED_${boundedAuthErrorEvidence(error)}`);
      }
      await wait(attempt * 1_000);
      continue;
    }
    const duration = performance.now() - started;
    if (!signedIn.error) {
      if (!signedIn.data.session || signedIn.data.user?.id !== user.id) {
        throw new Error('ZH_PASSWORD_SIGN_IN_SESSION_CONTRACT_MISMATCH');
      }
      return { client, duration };
    }
    const retryable =
      signedIn.error.status === 429 ||
      signedIn.error.status >= 500 ||
      TRANSIENT_NETWORK_ERROR.test(signedIn.error.message);
    if (!retryable || attempt === 8) {
      throw new Error(`ZH_PASSWORD_SIGN_IN_FAILED_${boundedAuthErrorEvidence(signedIn.error)}`);
    }
    await wait(attempt * 1_000);
  }
  throw new Error('ZH_PASSWORD_SIGN_IN_RETRY_EXHAUSTED');
}

async function prepareLocalCiLocaleFixture(databaseUrl) {
  const database = new PostgresClient({
    connectionString: databaseUrl,
    ssl: false,
    connectionTimeoutMillis: 5_000,
    query_timeout: 20_000,
    statement_timeout: 20_000,
    application_name: 'safetyhub-local-ci-capacity',
  });

  try {
    await database.connect();
    await database.query('begin');
    await database.query(`
      set local lock_timeout = '2s';
      set local statement_timeout = '20s';

      -- The hosted content source is never touched. This disposable fixture
      -- copies only public RU learner projections into the other locale keys
      -- so concurrency exercises all four routing/index paths. It contains no
      -- answer keys and disappears with the local CI containers.
      insert into public.test_revision_localizations (
        revision_id, locale, title, description, content, seo, sources,
        content_hash, translation_qa, published_at, published_by
      )
      select
        localization.revision_id,
        target.locale,
        localization.title,
        localization.description,
        localization.content,
        localization.seo,
        localization.sources,
        localization.content_hash,
        jsonb_build_object('mode', 'local-ci-load-fixture', 'locale', target.locale),
        localization.published_at,
        localization.published_by
      from public.test_revision_localizations localization
      join public.tests test on test.current_revision_id = localization.revision_id
      cross join unnest(array['kk', 'en', 'zh']::public.app_locale[]) target(locale)
      where localization.locale = 'ru'
        and test.status = 'published'
      on conflict (revision_id, locale) do nothing;

      insert into public.test_revision_variant_localizations (
        revision_id, variant_id, locale, questions, explanations,
        question_count, structure_hash, content_hash, created_at
      )
      select
        localization.revision_id,
        localization.variant_id,
        target.locale,
        localization.questions,
        localization.explanations,
        localization.question_count,
        localization.structure_hash,
        localization.content_hash,
        localization.created_at
      from public.test_revision_variant_localizations localization
      join public.tests test on test.current_revision_id = localization.revision_id
      cross join unnest(array['kk', 'en', 'zh']::public.app_locale[]) target(locale)
      where localization.locale = 'ru'
        and test.status = 'published'
      on conflict (variant_id, locale) do nothing;

      with candidates as materialized (
        select
          source.course_id,
          source.byte_size,
          source.sha256,
          source.page_count,
          source.aspect_ratio,
          source.created_by,
          source.created_at,
          source.validated_at,
          target.locale,
          extensions.gen_random_uuid() as localized_id
        from public.test_revision_presentations mapping
        join public.tests test on test.current_revision_id = mapping.revision_id
        join public.course_presentations source
          on source.id = mapping.presentation_id
        cross join unnest(array['kk', 'en', 'zh']::public.app_locale[]) target(locale)
        where mapping.locale = 'ru'
          and test.status = 'published'
          and source.status = 'ready'
          and not exists (
            select 1
            from public.course_presentations existing
            where existing.course_id = source.course_id
              and existing.locale = target.locale
              and existing.sha256 = source.sha256
              and existing.status = 'ready'
          )
      )
      insert into public.course_presentations (
        id, course_id, locale, storage_bucket, storage_path, thumbnail_path,
        source_filename, mime_type, byte_size, sha256, page_count,
        aspect_ratio, status, validation_error, created_by, created_at,
        validated_at, retired_at, cleanup_claimed_at
      )
      select
        candidate.localized_id,
        candidate.course_id,
        candidate.locale,
        'course-presentations',
        candidate.course_id::text || '/' || candidate.locale::text || '/'
          || candidate.localized_id::text || '/' || candidate.sha256 || '.pdf',
        candidate.course_id::text || '/' || candidate.locale::text || '/'
          || candidate.localized_id::text || '/' || candidate.sha256 || '-thumb.webp',
        'local-ci-' || candidate.locale::text || '-fixture.pdf',
        'application/pdf',
        candidate.byte_size,
        candidate.sha256,
        candidate.page_count,
        candidate.aspect_ratio,
        'ready',
        null,
        candidate.created_by,
        candidate.created_at,
        candidate.validated_at,
        null,
        null
      from candidates candidate
      on conflict do nothing;

      insert into public.test_revision_presentations (
        revision_id, locale, presentation_id
      )
      select
        source_mapping.revision_id,
        target_locale.locale,
        localized.id
      from public.test_revision_presentations source_mapping
      join public.tests test on test.current_revision_id = source_mapping.revision_id
      join public.course_presentations source
        on source.id = source_mapping.presentation_id
      cross join unnest(array['kk', 'en', 'zh']::public.app_locale[])
        target_locale(locale)
      join public.course_presentations localized
        on localized.course_id = source.course_id
       and localized.locale = target_locale.locale
       and localized.sha256 = source.sha256
       and localized.status = 'ready'
      where source_mapping.locale = 'ru'
        and test.status = 'published'
      on conflict (revision_id, locale) do nothing;

      do $fixture$
      begin
        if exists (
          select 1
          from public.tests test
          left join public.test_revision_localizations localization
            on localization.revision_id = test.current_revision_id
          where test.status = 'published'
          group by test.id
          having count(distinct localization.locale) <> 4
        ) or exists (
          select 1
          from public.tests test
          join public.test_revision_variants variant
            on variant.revision_id = test.current_revision_id
          left join public.test_revision_variant_localizations localization
            on localization.variant_id = variant.id
          where test.status = 'published'
          group by variant.id
          having count(distinct localization.locale) <> 4
        ) or exists (
          select 1
          from public.tests test
          left join public.test_revision_presentations mapping
            on mapping.revision_id = test.current_revision_id
          where test.status = 'published'
          group by test.id
          having count(distinct mapping.locale) <> 4
        ) then
          raise exception 'LOCAL_CI_FOUR_LOCALE_FIXTURE_INCOMPLETE';
        end if;
      end;
      $fixture$;
    `);
    await database.query('commit');
  } catch {
    try {
      await database.query('rollback');
    } catch {
      // The original failure remains authoritative.
    }
    throw new Error('LOCAL_CI_CONTENT_FIXTURE_FAILED');
  } finally {
    await database.end().catch(() => {});
  }

  process.stdout.write('LOAD_PREP_LOCALIZED_CONTENT=4-locales\n');
}

async function main() {
  await loadEnvironment();
  const url = required('NEXT_PUBLIC_SUPABASE_URL');
  const targetMode = process.env.SAFETYHUB_LOAD_TARGET ?? 'hosted-disposable';
  if (!['hosted-disposable', 'local-ci'].includes(targetMode)) {
    throw new Error('SAFETYHUB_LOAD_TARGET must be hosted-disposable or local-ci');
  }
  if (process.env.GITHUB_ACTIONS === 'true' && targetMode !== 'local-ci') {
    throw new Error('GitHub Actions load tests are restricted to local-ci');
  }

  const projectRef =
    targetMode === 'local-ci'
      ? assertLocalCiLoadTestTarget({
          url,
          databaseUrl: process.env.SAFETYHUB_LOCAL_DATABASE_URL,
          ci: process.env.CI,
          githubActions: process.env.GITHUB_ACTIONS,
          runnerEnvironment: process.env.RUNNER_ENVIRONMENT,
          marker: process.env.SAFETYHUB_LOCAL_LOAD_MARKER,
        })
      : assertLoadTestTarget({
          url,
          disposableRef: process.env.SAFETYHUB_LOAD_TEST_PROJECT_REF,
          confirmation: process.env.SAFETYHUB_LOAD_TEST_CONFIRM,
          marker: process.env.SAFETYHUB_LOAD_TEST_MARKER,
        });
  const publishableKey = required('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  const secretKey = required('SUPABASE_SECRET_KEY');
  if (targetMode === 'local-ci') {
    if (process.env.SUPABASE_ACCESS_TOKEN !== undefined) {
      throw new Error('SUPABASE_ACCESS_TOKEN must not be present in local-ci load mode');
    }
  } else {
    await assertDisposableProjectMarker({
      projectRef,
      accessToken: process.env.SUPABASE_ACCESS_TOKEN,
    });
  }

  if (process.env.SAFETYHUB_LOAD_RESUME !== undefined) {
    throw new Error('SAFETYHUB_LOAD_RESUME is disabled; a clean disposable project is required');
  }

  const userCount = positiveInteger('SAFETYHUB_LOAD_USERS', DEFAULT_USER_COUNT, MAX_MAU_PROFILE);
  const sessionCount = positiveInteger(
    'SAFETYHUB_LOAD_SESSIONS',
    DEFAULT_SESSION_COUNT,
    Math.min(100, userCount),
  );
  if (sessionCount < Math.max(...LOAD_WAVES.filter((count) => count <= userCount))) {
    throw new Error('SAFETYHUB_LOAD_SESSIONS must cover the requested concurrency waves');
  }

  const admin = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  if (targetMode === 'local-ci') {
    await assertLocalCiCleanLoadTestBaseline(admin);
  } else {
    await assertCleanLoadTestBaseline(admin);
  }
  if (targetMode === 'local-ci') {
    await prepareLocalCiLocaleFixture(process.env.SAFETYHUB_LOCAL_DATABASE_URL);
  }

  const legalVersions = await admin
    .from('legal_document_versions')
    .select('document_type,version,body_revision')
    .eq('is_current', true);
  if (legalVersions.error) throw legalVersions.error;
  const privacy = legalVersions.data.find((document) => document.document_type === 'privacy');
  const terms = legalVersions.data.find((document) => document.document_type === 'terms');
  if (!privacy || !terms || legalVersions.data.length !== 2) {
    throw new Error('exact current legal document pair is required for ZH load registration');
  }
  const currentLegal = {
    privacy: { version: privacy.version, bodyRevision: privacy.body_revision },
    terms: { version: terms.version, bodyRevision: terms.body_revision },
  };

  await rpcData(admin, 'set_runtime_feature_flag', {
    p_feature_name: 'zh_username_password',
    p_enabled: true,
    p_reason: 'Disposable load test: enable ZH username/password authentication',
    p_idempotency_key: crypto.randomUUID(),
  });
  const zhRolloutEnabled = await rpcData(admin, 'get_zh_username_password_rollout_enabled');
  if (zhRolloutEnabled !== true) {
    throw new Error('ZH_USERNAME_PASSWORD_ROLLOUT_CONTRACT_MISMATCH');
  }

  const indexes = Array.from({ length: userCount }, (_, index) => index);
  const createdUsers = await mapLimit(indexes, PREPARATION_CONCURRENCY, (index) =>
    createZhLoadTestUser(admin, index, currentLegal),
  );
  process.stdout.write(`LOAD_PREP_USERS=${createdUsers.length}\n`);

  const now = new Date().toISOString();
  const profiles = createdUsers.map((user) => user.profile);
  await insertChunks(admin, 'profiles', profiles, { upsert: true, onConflict: 'id' });
  await insertChunks(
    admin,
    'verified_identities',
    profiles.map((profile) => ({
      user_id: profile.id,
      status: 'verified',
      version: 1,
      name: profile.name,
      surname: profile.surname,
      job: profile.job,
      organization: profile.organization,
      verified_at: now,
    })),
    { upsert: true, onConflict: 'user_id' },
  );
  for (const userIds of chunks(
    createdUsers.map((user) => user.id),
    100,
  )) {
    const approved = await admin
      .from('account_controls')
      // account_controls_approval_state_shape allows an approved account only
      // with the whole decision recorded (requested, due and decided together)
      // or with none of it. A seeded load user never went through a review, so
      // it takes the second shape; a decision timestamp on its own is rejected.
      .update({
        approval_state: 'approved',
        approval_requested_at: null,
        approval_due_at: null,
        approval_decided_at: null,
        approval_decided_by: null,
        approval_rejection_reason: null,
      })
      .in('user_id', userIds);
    if (approved.error) throw approved.error;
  }
  process.stdout.write('LOAD_PREP_IDENTITIES=ready\n');

  const revisionsResult = await admin
    .from('test_revisions')
    .select(
      'id,test_id,slug,question_count,pass_score,duration_minutes,attempts_per_calendar_day,attempt_reset_timezone,variants:test_revision_variants(id,variant_number)',
    )
    .order('slug');
  if (revisionsResult.error) throw revisionsResult.error;
  const revisions = revisionsResult.data;
  const loadRevision = revisions.find((revision) => revision.slug === 'pozharnaya-bezopasnost');
  if (!loadRevision) {
    throw new Error(
      'Canonical pozharnaya-bezopasnost revision is required before destructive load seeding',
    );
  }
  const synthetic = buildSyntheticDomainData(createdUsers, revisions, now);
  await insertChunks(admin, 'test_attempts', synthetic.attempts);
  await insertChunks(admin, 'attestations', synthetic.attestations);
  process.stdout.write(
    `LOAD_PREP_DOMAIN=attempts:${synthetic.attempts.length},attestations:${synthetic.attestations.length}\n`,
  );

  const adminAccess = await admin.rpc('restore_admin_access', { p_user_id: createdUsers[0].id });
  if (adminAccess.error) throw adminAccess.error;

  const zhPasswordLoginWaveResults = [];
  const localCiCaptchaToken =
    targetMode === 'local-ci' ? LOCAL_CI_TURNSTILE_DUMMY_TOKEN : undefined;
  for (const concurrency of LOAD_WAVES.filter((count) => count <= createdUsers.length)) {
    const sessions = await Promise.all(
      createdUsers
        .slice(0, concurrency)
        .map((user) => createAuthenticatedClient(url, publishableKey, user, localCiCaptchaToken)),
    );
    zhPasswordLoginWaveResults.push({
      concurrency,
      signInP95Ms: percentile(
        sessions.map((item) => item.duration),
        95,
      ),
    });
    process.stdout.write(`LOAD_ZH_PASSWORD_LOGIN_WAVE_COMPLETE=${concurrency}\n`);
  }
  const sessionUsers = createdUsers.slice(0, sessionCount);
  const clientSessions = await mapLimit(sessionUsers, PREPARATION_CONCURRENCY, (user) =>
    createAuthenticatedClient(url, publishableKey, user, localCiCaptchaToken),
  );
  const clients = clientSessions.map((session) => session.client);
  process.stdout.write(`LOAD_SESSIONS_READY=${clients.length}/${sessionUsers.length}\n`);

  await rpcData(admin, 'set_runtime_feature_flag', {
    p_feature_name: 'notification_events',
    p_enabled: true,
    p_reason: 'Disposable load test: measure transactional event creation',
    p_idempotency_key: crypto.randomUUID(),
  });
  await rpcData(admin, 'set_runtime_feature_flag', {
    p_feature_name: 'telegram_delivery',
    p_enabled: true,
    p_reason: 'Disposable load test: measure delivery claim and completion',
    p_idempotency_key: crypto.randomUUID(),
  });

  const waveResults = [];
  for (const concurrency of LOAD_WAVES.filter((count) => count <= clients.length)) {
    process.stdout.write(`LOAD_WAVE_START=${concurrency}\n`);
    const activeClients = clients.slice(0, concurrency);
    const localeByIndex = activeClients.map((_, index) => APP_LOCALES[index % APP_LOCALES.length]);
    const catalogReads = await Promise.all(
      activeClients.map((client, index) =>
        timedRpc(client, 'list_published_courses_locale', {
          p_locale: localeByIndex[index],
        }),
      ),
    );
    for (let index = 0; index < catalogReads.length; index += 1) {
      const result = catalogReads[index].data;
      if (
        !result ||
        typeof result !== 'object' ||
        !Array.isArray(result.items) ||
        !result.items.some(
          (item) =>
            item?.slug === 'pozharnaya-bezopasnost' && item?.locale === localeByIndex[index],
        )
      ) {
        throw new Error(`localized catalog contract mismatch: ${localeByIndex[index]}`);
      }
      assertNoForbiddenLearnerKeys(result, 'localized catalog');
    }
    const courseReads = await Promise.all(
      activeClients.map((client, index) =>
        timedRpc(client, 'get_published_course_locale', {
          p_slug: 'pozharnaya-bezopasnost',
          p_locale: localeByIndex[index],
        }),
      ),
    );
    for (let index = 0; index < courseReads.length; index += 1) {
      const result = courseReads[index].data;
      if (
        !result ||
        typeof result !== 'object' ||
        result.slug !== 'pozharnaya-bezopasnost' ||
        result.locale !== localeByIndex[index]
      ) {
        throw new Error(`localized course contract mismatch: ${localeByIndex[index]}`);
      }
      assertNoForbiddenLearnerKeys(result, 'localized course');
    }
    const presentationReads = await Promise.all(
      activeClients.map((client) =>
        timedRpc(client, 'get_approved_course_presentation_locale', {
          p_course_slug: 'pozharnaya-bezopasnost',
          p_asset: 'presentation',
          p_locale: 'zh',
        }),
      ),
    );
    for (const presentation of presentationReads) {
      const result = presentation.data;
      if (
        !Array.isArray(result) ||
        result.length !== 1 ||
        result[0]?.content_type !== 'application/pdf' ||
        !Number.isSafeInteger(Number(result[0]?.byte_size)) ||
        Number(result[0]?.byte_size) < 1
      ) {
        throw new Error('approved presentation metadata contract mismatch');
      }
      assertNoForbiddenLearnerKeys(result, 'approved presentation metadata');
      if (JSON.stringify(result).match(/storage_(?:bucket|path)|thumbnail_path/iu)) {
        throw new Error('approved presentation metadata leaked a private storage locator');
      }
    }
    const starts = await Promise.all(
      activeClients.map((client) =>
        timedRpc(client, 'start_test_attempt_locale', {
          p_test_slug: 'pozharnaya-bezopasnost',
          p_locale: 'zh',
        }),
      ),
    );
    for (let index = 0; index < starts.length; index += 1) {
      if (starts[index].data?.locale !== 'zh') {
        throw new Error(
          `localized attempt contract mismatch: zh (got ${JSON.stringify(starts[index].data)})`,
        );
      }
      assertNoForbiddenLearnerKeys(starts[index].data, 'localized attempt');
    }
    const completions = await Promise.all(
      starts.map(({ data }, index) =>
        timedRpc(activeClients[index], 'complete_test_attempt', {
          p_attempt_id: data.attemptId,
          p_answers: data.questions.map((question) => ({
            questionId: question.id,
            optionId: question.options[0].id,
          })),
        }),
      ),
    );
    waveResults.push({
      concurrency,
      catalogReadP50Ms: percentile(
        catalogReads.map((item) => item.duration),
        50,
      ),
      catalogReadP95Ms: percentile(
        catalogReads.map((item) => item.duration),
        95,
      ),
      courseReadP50Ms: percentile(
        courseReads.map((item) => item.duration),
        50,
      ),
      courseReadP95Ms: percentile(
        courseReads.map((item) => item.duration),
        95,
      ),
      presentationReadP50Ms: percentile(
        presentationReads.map((item) => item.duration),
        50,
      ),
      presentationReadP95Ms: percentile(
        presentationReads.map((item) => item.duration),
        95,
      ),
      startP50Ms: percentile(
        starts.map((item) => item.duration),
        50,
      ),
      startP95Ms: percentile(
        starts.map((item) => item.duration),
        95,
      ),
      completeP50Ms: percentile(
        completions.map((item) => item.duration),
        50,
      ),
      completeP95Ms: percentile(
        completions.map((item) => item.duration),
        95,
      ),
    });
    process.stdout.write(`LOAD_WAVE_COMPLETE=${concurrency}\n`);
  }

  const adminClient = clients[0];
  const inboxReads = await Promise.all(
    Array.from({ length: 10 }, () =>
      timedRpc(adminClient, 'list_admin_notification_inbox', {
        p_limit: 50,
        p_before_occurred_at: null,
        p_before_id: null,
      }),
    ),
  );
  for (const inbox of inboxReads) {
    if (
      !inbox.data ||
      typeof inbox.data !== 'object' ||
      !Array.isArray(inbox.data.items) ||
      !Number.isInteger(Number(inbox.data.unread))
    ) {
      throw new Error('admin notification inbox contract mismatch');
    }
  }

  const claimReads = await Promise.all(
    Array.from({ length: 20 }, () =>
      timedRpc(admin, 'claim_notification_deliveries', {
        p_worker_id: crypto.randomUUID(),
        p_limit: 12,
        p_lease_seconds: 45,
      }),
    ),
  );
  const claimedDeliveries = claimReads.flatMap((claim) => notificationClaims(claim.data));
  if (
    new Set(claimedDeliveries.map((claim) => claim.deliveryId)).size !== claimedDeliveries.length
  ) {
    throw new Error('notification claim returned a duplicate delivery');
  }
  const deliveryCompletions = await mapLimit(claimedDeliveries, 20, (claim) =>
    timedRpc(admin, 'complete_notification_delivery', {
      p_delivery_id: claim.deliveryId,
      p_lease_token: claim.leaseToken,
      p_remote_message_id: `load-${claim.eventId}`,
    }),
  );
  if (deliveryCompletions.some((completion) => completion.data !== true)) {
    throw new Error('notification completion contract mismatch');
  }

  const eligibleResult = await admin
    .from('attestations')
    .select('id,best_score,revision_id')
    .limit(1_000);
  if (eligibleResult.error) throw eligibleResult.error;
  const passByRevision = new Map(revisions.map((revision) => [revision.id, revision.pass_score]));
  const eligibleIds = eligibleResult.data
    .filter((item) => item.best_score >= passByRevision.get(item.revision_id))
    .slice(0, 100)
    .map((item) => item.id);
  const issueResult = await timedRpc(adminClient, 'issue_certificates', {
    p_attestation_ids: eligibleIds,
  });

  const certificateRows = await admin
    .from('certificates')
    .select('id')
    .is('revoked_at', null)
    .order('issued_at', { ascending: false })
    .limit(100);
  if (certificateRows.error) throw certificateRows.error;
  const certificateMetadata = await Promise.all(
    certificateRows.data.map((certificate) =>
      timedRpc(adminClient, 'get_certificate_download_payload', {
        p_certificate_id: certificate.id,
      }),
    ),
  );
  for (const metadata of certificateMetadata) {
    if (!metadata.data || typeof metadata.data !== 'object') {
      throw new Error('certificate metadata contract mismatch');
    }
    assertNoForbiddenLearnerKeys(metadata.data, 'certificate metadata');
  }

  const adminPageDurations = [];
  for (let index = 0; index < 10; index += 1) {
    const page = await timedRpc(adminClient, 'list_admin_attestations_page', {
      p_limit: index % 2 === 0 ? 50 : 100,
      p_query: null,
      p_organization: null,
      p_test_id: null,
      p_result_state: null,
      p_certificate_state: null,
      p_from: null,
      p_to: null,
      p_sort: 'completed_desc',
      p_cursor: null,
    });
    adminPageDurations.push(page.duration);
  }
  const exportResult = await timedRpc(adminClient, 'resolve_certificate_export', {
    p_attestation_ids: eligibleIds,
  });
  const metrics = await admin.rpc('get_capacity_metrics');
  if (metrics.error) throw metrics.error;

  const report = {
    projectRef,
    synthetic: true,
    users: createdUsers.length,
    attemptsSeeded: synthetic.attempts.length,
    attestationsSeeded: synthetic.attestations.length,
    zhUsernamePasswordRegistration: {
      count: createdUsers.length,
      completeP95Ms: percentile(
        createdUsers.map((user) => user.registrationMetrics.completeMs),
        95,
      ),
      mappingP95Ms: percentile(
        createdUsers.map((user) => user.registrationMetrics.mappingMs),
        95,
      ),
    },
    zhPasswordLoginWaveResults,
    waveResults,
    adminInboxP95Ms: percentile(
      inboxReads.map((item) => item.duration),
      95,
    ),
    notificationClaimP95Ms: percentile(
      claimReads.map((item) => item.duration),
      95,
    ),
    notificationClaimed: claimedDeliveries.length,
    notificationCompleteP95Ms: percentile(
      deliveryCompletions.map((item) => item.duration),
      95,
    ),
    adminPageP95Ms: percentile(adminPageDurations, 95),
    issueDurationMs: Number(issueResult.duration.toFixed(1)),
    issued: Array.isArray(issueResult.data)
      ? issueResult.data.filter((item) => item.status === 'completed').length
      : null,
    exportResolutionMs: Number(exportResult.duration.toFixed(1)),
    exportEligible: exportResult.data?.eligible ?? exportResult.data?.items?.length ?? null,
    certificateMetadataResolved: certificateMetadata.length,
    certificateMetadataP95Ms: percentile(
      certificateMetadata.map((item) => item.duration),
      95,
    ),
    database: metrics.data,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
