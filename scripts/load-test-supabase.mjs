import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import sharp from 'sharp';
import { createClient } from '@supabase/supabase-js';
import {
  assertCleanLoadTestBaseline,
  assertDisposableProjectMarker,
  assertLoadTestTarget,
} from './load-test-safety.mjs';

const DEFAULT_USER_COUNT = 1_000;
const DEFAULT_SESSION_COUNT = 100;
const LOAD_WAVES = [25, 50, 100];
const ROW_CHUNK = 400;
const PREPARATION_RETRY_LIMIT = 5;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
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
  const local = parseEnvFile(await readFile('.env.local', 'utf8'));
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
      throw new Error(`createUser ${index + 1}: ${message}`);
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

function avatarOperation(value, userId, expectedStatus, expectedToken) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Avatar operation returned an invalid response');
  }
  const token = value.operationToken;
  if (
    value.status !== expectedStatus ||
    typeof token !== 'string' ||
    !UUID_PATTERN.test(token) ||
    (expectedToken !== undefined && token !== expectedToken) ||
    value.objectKey !== `${userId}/objects/${token}.webp`
  ) {
    throw new Error('Avatar operation contract mismatch');
  }
  return { token, objectKey: value.objectKey };
}

async function rpcData(client, name, args) {
  const result = await client.rpc(name, args);
  if (result.error) throw new Error(`${name}: ${result.error.message}`);
  return result.data;
}

async function seedProfileAvatar(admin, user, avatar, sha256) {
  const begun = avatarOperation(
    await rpcData(admin, 'begin_profile_avatar_upload', {
      p_user_id: user.id,
      p_expected_sha256: sha256,
      p_expected_bytes: avatar.length,
    }),
    user.id,
    'prepared',
  );

  const uploaded = await admin.storage.from('profile-avatars').upload(begun.objectKey, avatar, {
    contentType: 'image/webp',
    cacheControl: '600',
    upsert: false,
  });
  if (uploaded.error || uploaded.data?.path !== begun.objectKey) {
    await admin.rpc('finish_profile_avatar_storage_write', {
      p_user_id: user.id,
      p_operation_token: begun.token,
      p_error_code: 'LOAD_TEST_AVATAR_UPLOAD_FAILED',
    });
    await admin.rpc('abort_profile_avatar_upload', {
      p_user_id: user.id,
      p_operation_token: begun.token,
      p_error_code: 'LOAD_TEST_AVATAR_UPLOAD_FAILED',
    });
    throw new Error(`avatar ${user.id}: immutable Storage upload failed`);
  }

  avatarOperation(
    await rpcData(admin, 'finish_profile_avatar_storage_write', {
      p_user_id: user.id,
      p_operation_token: begun.token,
      p_error_code: null,
    }),
    user.id,
    'prepared',
    begun.token,
  );
  avatarOperation(
    await rpcData(admin, 'mark_profile_avatar_staged', {
      p_user_id: user.id,
      p_operation_token: begun.token,
      p_observed_sha256: sha256,
      p_observed_bytes: avatar.length,
    }),
    user.id,
    'staged',
    begun.token,
  );
  avatarOperation(
    await rpcData(admin, 'finalize_profile_avatar_upload', {
      p_user_id: user.id,
      p_operation_token: begun.token,
    }),
    user.id,
    'committed',
    begun.token,
  );
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
    onboarding_completed_at: timestamp,
  };
}

function buildSyntheticDomainData(users, revisions, timestamp) {
  const attempts = [];
  const attestations = [];
  const audits = [];
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

    audits.push({
      actor_user_id: null,
      target_user_id: user.id,
      target_type: 'user',
      target_id: user.id,
      action: 'load_test.seeded',
      after_data: { synthetic: true },
      correlation_id: crypto.randomUUID(),
      created_at: timestamp,
    });
  });

  return { attempts, attestations, audits };
}

async function timedRpc(client, name, args) {
  const started = performance.now();
  const result = await client.rpc(name, args);
  const duration = performance.now() - started;
  if (result.error) throw new Error(`${name}: ${result.error.message}`);
  return { data: result.data, duration };
}

async function createAuthenticatedClient(url, publishableKey, user, password) {
  const client = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const signedIn = await client.auth.signInWithPassword({ email: user.email, password });
    if (!signedIn.error) return client;
    const retryable =
      signedIn.error.status === 429 || TRANSIENT_NETWORK_ERROR.test(signedIn.error.message);
    if (!retryable || attempt === 8) {
      throw new Error(`signInWithPassword: ${signedIn.error.message}`);
    }
    await wait(attempt * 1_000);
  }
  throw new Error('signInWithPassword exhausted its retry budget');
}

async function main() {
  await loadEnvironment();
  const url = required('NEXT_PUBLIC_SUPABASE_URL');
  const projectRef = assertLoadTestTarget({
    url,
    disposableRef: process.env.SAFETYHUB_LOAD_TEST_PROJECT_REF,
    confirmation: process.env.SAFETYHUB_LOAD_TEST_CONFIRM,
    marker: process.env.SAFETYHUB_LOAD_TEST_MARKER,
  });
  const publishableKey = required('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  const secretKey = required('SUPABASE_SECRET_KEY');
  await assertDisposableProjectMarker({
    projectRef,
    accessToken: process.env.SUPABASE_ACCESS_TOKEN,
  });

  if (process.env.SAFETYHUB_LOAD_RESUME !== undefined) {
    throw new Error('SAFETYHUB_LOAD_RESUME is disabled; a clean disposable project is required');
  }

  const userCount = positiveInteger('SAFETYHUB_LOAD_USERS', DEFAULT_USER_COUNT, 1_000);
  const sessionCount = positiveInteger(
    'SAFETYHUB_LOAD_SESSIONS',
    DEFAULT_SESSION_COUNT,
    Math.min(100, userCount),
  );
  if (sessionCount < Math.max(...LOAD_WAVES.filter((count) => count <= userCount))) {
    throw new Error('SAFETYHUB_LOAD_SESSIONS must cover the requested concurrency waves');
  }
  if (userCount < sessionCount + 100) {
    throw new Error(
      'SAFETYHUB_LOAD_USERS must reserve 100 worst-window users outside the session cohort',
    );
  }

  const admin = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  await assertCleanLoadTestBaseline(admin);

  const runId = Date.now().toString(36);
  const indexes = Array.from({ length: userCount }, (_, index) => index);
  const createdUsers = await mapLimit(indexes, 8, async (index) => {
    const email = `safetyhub-load-${runId}-${String(index + 1).padStart(4, '0')}@example.test`;
    const id = crypto.randomUUID();
    return createLoadTestUser(
      () =>
        admin.auth.admin.createUser({
          id,
          email,
          email_confirm: true,
          user_metadata: { safetyhub_load_test: true },
        }),
      () => admin.auth.admin.getUserById(id),
      { id, email },
      index,
    );
  });
  process.stdout.write(`LOAD_PREP_USERS=${createdUsers.length}\n`);

  const now = new Date().toISOString();
  const profiles = createdUsers.map((user, index) => buildProfile(user, index, now));
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
  process.stdout.write('LOAD_PREP_IDENTITIES=ready\n');

  const legalVersions = await admin
    .from('legal_document_versions')
    .select('document_type,version')
    .eq('is_current', true);
  if (legalVersions.error) throw legalVersions.error;
  await insertChunks(
    admin,
    'legal_acceptances',
    createdUsers.flatMap((user) =>
      legalVersions.data.map((document) => ({
        user_id: user.id,
        document_type: document.document_type,
        version: document.version,
        source: 'registration',
      })),
    ),
  );

  const revisionsResult = await admin
    .from('test_revisions')
    .select(
      'id,test_id,slug,question_count,pass_score,duration_minutes,attempts_per_calendar_day,attempt_reset_timezone,variants:test_revision_variants(id,variant_number)',
    )
    .order('slug');
  if (revisionsResult.error) throw revisionsResult.error;
  const revisions = revisionsResult.data;
  const loadRevision = revisions.find(
    (revision) => revision.slug === 'pozharnaya-bezopasnost',
  );
  if (!loadRevision) {
    throw new Error(
      'Canonical pozharnaya-bezopasnost revision is required before destructive load seeding',
    );
  }
  const synthetic = buildSyntheticDomainData(createdUsers, revisions, now);
  await insertChunks(admin, 'test_attempts', synthetic.attempts);
  await insertChunks(admin, 'attestations', synthetic.attestations);
  await insertChunks(admin, 'admin_audit_log', synthetic.audits);
  process.stdout.write(
    `LOAD_PREP_DOMAIN=attempts:${synthetic.attempts.length},attestations:${synthetic.attestations.length}\n`,
  );

  const noise = crypto.randomBytes(360 * 360 * 3);
  const avatar = await sharp(noise, { raw: { width: 360, height: 360, channels: 3 } })
    .blur(1)
    .webp({ quality: 60 })
    .toBuffer();
  if (avatar.length > 100 * 1_024 || avatar.length < 20 * 1_024) {
    throw new Error(`Representative avatar size is outside 20–100 KiB: ${avatar.length}`);
  }
  const avatarSha256 = crypto.createHash('sha256').update(avatar).digest('hex');
  await mapLimit(createdUsers, 16, async (user) => {
    await seedProfileAvatar(admin, user, avatar, avatarSha256);
  });
  process.stdout.write(`LOAD_PREP_AVATARS=${createdUsers.length}\n`);

  const adminAccess = await admin.rpc('restore_admin_access', { p_user_id: createdUsers[0].id });
  if (adminAccess.error) throw adminAccess.error;
  const sessionUsers = createdUsers.slice(0, sessionCount);
  const loadPassword = `SafetyHub-load-${crypto.randomBytes(18).toString('base64url')}!`;
  await mapLimit(sessionUsers, 12, async (user) => {
    const updated = await admin.auth.admin.updateUserById(user.id, { password: loadPassword });
    if (updated.error) throw new Error(`set load password: ${updated.error.message}`);
  });
  const clients = [];
  for (let index = 0; index < sessionUsers.length; index += 1) {
    const user = sessionUsers[index];
    clients.push(await createAuthenticatedClient(url, publishableKey, user, loadPassword));
    if ((index + 1) % 10 === 0 || index + 1 === sessionUsers.length) {
      process.stdout.write(`LOAD_SESSIONS_READY=${index + 1}/${sessionUsers.length}\n`);
    }
    await wait(2_100);
  }

  const waveResults = [];
  for (const concurrency of LOAD_WAVES.filter((count) => count <= clients.length)) {
    process.stdout.write(`LOAD_WAVE_START=${concurrency}\n`);
    const activeClients = clients.slice(0, concurrency);
    const starts = await Promise.all(
      activeClients.map((client) =>
        timedRpc(client, 'start_test_attempt', {
          p_test_slug: 'pozharnaya-bezopasnost',
        }),
      ),
    );
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
    avatars: createdUsers.length,
    avatarBytesEach: avatar.length,
    waveResults,
    adminPageP95Ms: percentile(adminPageDurations, 95),
    issueDurationMs: Number(issueResult.duration.toFixed(1)),
    issued: Array.isArray(issueResult.data)
      ? issueResult.data.filter((item) => item.status === 'completed').length
      : null,
    exportResolutionMs: Number(exportResult.duration.toFixed(1)),
    exportEligible: exportResult.data?.eligible ?? exportResult.data?.items?.length ?? null,
    database: metrics.data,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
