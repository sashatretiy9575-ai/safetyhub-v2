import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const allowRemote = process.argv.includes('--allow-remote') || process.env.ALLOW_TEST_DATA === '1';

if (!url || !secret) {
  throw new Error(
    'Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY).',
  );
}

const hostname = new URL(url).hostname;
if (!allowRemote && !['127.0.0.1', 'localhost'].includes(hostname)) {
  throw new Error(
    'The workspace seed is local-only. Pass --allow-remote or ALLOW_TEST_DATA=1 for an isolated staging project.',
  );
}

const supabase = createClient(url, secret, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function must(label, result) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

async function mapLimit(values, concurrency, worker) {
  let cursor = 0;
  const results = new Array(values.length);
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        results[index] = await worker(values[index], index);
      }
    }),
  );
  return results;
}

async function existingUsers() {
  const users = [];
  for (let page = 1; ; page += 1) {
    const data = must(
      `list auth users page ${page}`,
      await supabase.auth.admin.listUsers({ page, perPage: 1_000 }),
    );
    users.push(...data.users);
    if (data.users.length < 1_000) return new Map(users.map((user) => [user.email, user]));
  }
}

const companies = [
  'ТОО Арман Строй',
  'ТОО «Арман Строй»',
  'Арман-Строй, ТОО',
  'ТОО Восток Энерго',
  'Восток Энерго ТОО',
  'АО Каспий Пром',
  'Каспий-Пром АО',
  'ТОО Орда Сервис',
  'ТОО «Казахстанский центр промышленной, пожарной и производственной безопасности Северо-Каспийского региона»',
];
const jobs = [
  'Инженер по ОТ',
  'Электромонтёр',
  'Мастер участка',
  'Оператор',
  'Начальник смены',
  'Главный специалист по координации производственной безопасности, охране труда и предупреждению чрезвычайных ситуаций',
];
const surnames = [
  'Ахметов',
  'Бекова',
  'Ермеков',
  'Ибраева',
  'Касымов',
  'Мусина',
  'Нургалиев',
  'Омарова',
  'Сериков',
  'Тлеубаева',
];
const names = ['Айдар', 'Алия', 'Данияр', 'Жанна', 'Марат', 'Сауле', 'Тимур', 'Фарида'];

const accounts = [
  {
    email: process.env.E2E_ADMIN_EMAIL ?? 'admin@safetyhub.local',
    role: 'admin',
    name: 'Администратор',
    surname: 'SafetyHub',
    job: 'Администратор платформы',
    organization: 'SafetyHub',
  },
  {
    email: process.env.E2E_PARTICIPANT_EMAIL ?? 'participant@safetyhub.local',
    role: 'participant',
    name: 'Алия',
    surname: 'Участник',
    job: 'Инженер по ОТ',
    organization: 'ТОО Арман Строй',
  },
  ...Array.from({ length: 100 }, (_, index) => ({
    email:
      index === 99
        ? 'employee.with.a.deliberately.long.address.for.responsive.testing@safetyhub.local'
        : `employee${String(index + 1).padStart(3, '0')}@safetyhub.local`,
    role: 'participant',
    name: names[index % names.length],
    surname: `${surnames[index % surnames.length]} ${String(index + 1).padStart(3, '0')}`,
    job: jobs[index % jobs.length],
    organization: companies[index % companies.length],
  })),
];

const knownUsers = await existingUsers();
const users = await mapLimit(accounts, 6, async (account) => {
  let user = knownUsers.get(account.email);
  if (!user) {
    const data = must(
      `create ${account.email}`,
      await supabase.auth.admin.createUser({
        email: account.email,
        email_confirm: true,
        user_metadata: { name: account.name, surname: account.surname, job: account.job },
      }),
    );
    user = data.user;
  } else {
    must(
      `refresh ${account.email}`,
      await supabase.auth.admin.updateUserById(user.id, {
        email_confirm: true,
        user_metadata: { name: account.name, surname: account.surname, job: account.job },
      }),
    );
  }
  if (!user) throw new Error(`Auth did not return ${account.email}.`);
  return { ...account, id: user.id };
});

must(
  'upsert profiles',
  await supabase.from('profiles').upsert(
    users.map((user) => ({
      id: user.id,
      name: user.name,
      surname: user.surname,
      job: user.job,
      organization: user.organization,
      onboarding_completed_at: '2026-08-01T08:00:00.000Z',
    })),
    { onConflict: 'id' },
  ),
);

must(
  'upsert product roles',
  await supabase.from('user_roles').upsert(
    users.map((user) => ({
      user_id: user.id,
      role: user.role === 'admin' ? 'admin' : 'user',
      product_role: user.role,
    })),
    { onConflict: 'user_id' },
  ),
);

// The two authenticated release-E2E identities exercise their actual admin
// and learner workspaces. New accounts correctly start as profile_incomplete,
// so this disposable fixture must approve those identities explicitly before
// the learner dashboard is tested.
const authenticatedE2eUsers = users.slice(0, 2);
const approvedE2eControls = must(
  'approve authenticated E2E identities',
  await supabase
    .from('account_controls')
    .update({
      approval_state: 'approved',
      approval_requested_at: null,
      approval_due_at: null,
      approval_decided_at: null,
      approval_decided_by: null,
      approval_rejection_reason: null,
    })
    .in(
      'user_id',
      authenticatedE2eUsers.map((user) => user.id),
    )
    .select('user_id,approval_state'),
);
const approvedE2eUserIds = new Set(approvedE2eControls.map((control) => control.user_id));
if (
  approvedE2eControls.length !== authenticatedE2eUsers.length ||
  approvedE2eControls.some((control) => control.approval_state !== 'approved') ||
  authenticatedE2eUsers.some((user) => !approvedE2eUserIds.has(user.id))
) {
  throw new Error('Authenticated E2E identities were not approved deterministically.');
}

const currentLegalDocuments = must(
  'read current legal documents',
  await supabase
    .from('legal_document_versions')
    .select('document_type,version')
    .eq('is_current', true),
);
if (currentLegalDocuments.length !== 2) {
  throw new Error(
    `Expected exactly two current legal documents, received ${currentLegalDocuments.length}.`,
  );
}
must(
  'seed current legal acceptances',
  await supabase.from('legal_acceptances').upsert(
    users.flatMap((user) =>
      currentLegalDocuments.map((document) => ({
        user_id: user.id,
        document_type: document.document_type,
        version: document.version,
        source: 'registration',
      })),
    ),
    {
      onConflict: 'user_id,document_type,version',
      ignoreDuplicates: true,
    },
  ),
);

const admin = users[0];
const participants = users.slice(1);
const verifiedUsers = participants.filter((_, index) => index % 4 !== 0);
must(
  'seed verified identities',
  await supabase.from('verified_identities').upsert(
    verifiedUsers.map((user) => ({
      user_id: user.id,
      status: 'verified',
      version: 1,
      name: user.name,
      surname: user.surname,
      job: user.job,
      organization: user.organization,
      verified_at: '2026-08-05T08:00:00.000Z',
      verified_by: admin.id,
      revoked_at: null,
      revoked_by: null,
      revoke_reason: null,
    })),
    { onConflict: 'user_id' },
  ),
);

const publishedCourses = must(
  'read published courses',
  await supabase
    .from('tests')
    .select('id,current_revision_id,display_order')
    .eq('status', 'published')
    .not('current_revision_id', 'is', null)
    .order('display_order', { ascending: true }),
);
const currentRevisionIds = publishedCourses.map((course) => course.current_revision_id);
const revisionRows = currentRevisionIds.length
  ? must(
      'read current published revisions',
      await supabase
        .from('test_revisions')
        .select(
          'id,test_id,slug,title,question_count,pass_score,version,duration_minutes,attempts_per_calendar_day,attempt_reset_timezone,variants:test_revision_variants(id,variant_number,question_count)',
        )
        .in('id', currentRevisionIds),
    )
  : [];
const revisionsById = new Map(revisionRows.map((revision) => [revision.id, revision]));
const revisions = publishedCourses.map((course) => {
  const revision = revisionsById.get(course.current_revision_id);
  if (!revision || revision.test_id !== course.id) {
    throw new Error(`Published course ${course.id} has no matching current revision.`);
  }
  const variants = [...(revision.variants ?? [])].sort(
    (left, right) => left.variant_number - right.variant_number,
  );
  if (!variants.length) {
    throw new Error(`Current revision ${revision.id} has no assessment variant.`);
  }
  return { ...revision, variants };
});

if (!revisions.length) {
  console.warn(
    'Created accounts, profiles and companies; run supabase/seed.sql first to seed course revisions.',
  );
} else {
  const attempts = [];
  const attestations = [];
  const certificates = [];
  for (let index = 0; index < participants.length; index += 1) {
    const user = participants[index];
    const revision = revisions[index % revisions.length];
    const variant = revision.variants[index % revision.variants.length];
    const passed = index % 5 !== 0;
    const attemptId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    const attestationId = `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    const score = passed ? variant.question_count : Math.max(0, revision.pass_score - 1);
    const completedAt = new Date(Date.UTC(2026, 7, 17 - (index % 14), 9, index % 60)).toISOString();
    const startedAt = new Date(new Date(completedAt).getTime() - 4 * 60_000).toISOString();
    attempts.push({
      id: attemptId,
      user_id: user.id,
      test_id: revision.test_id,
      revision_id: revision.id,
      variant_id: variant.id,
      duration_minutes: revision.duration_minutes,
      pass_score: revision.pass_score,
      attempts_per_day: revision.attempts_per_calendar_day,
      reset_timezone: revision.attempt_reset_timezone,
      status: passed ? 'passed' : 'failed',
      answers: Array.from({ length: variant.question_count }, () => 0),
      score,
      started_at: startedAt,
      expires_at: new Date(
        new Date(startedAt).getTime() + revision.duration_minutes * 60_000,
      ).toISOString(),
      completed_at: completedAt,
    });
    if (!passed) continue;
    attestations.push({
      id: attestationId,
      user_id: user.id,
      revision_id: revision.id,
      best_attempt_id: attemptId,
      best_score: score,
      best_completed_at: completedAt,
    });
    if (index % 3 !== 1 || !verifiedUsers.some((item) => item.id === user.id)) continue;
    const certificateId = `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    const revoked = index % 17 === 0;
    certificates.push({
      id: certificateId,
      certificate_number: `SH-E2E-${String(index + 1).padStart(5, '0')}`,
      user_id: user.id,
      revision_id: revision.id,
      attestation_id: attestationId,
      attempt_id: attemptId,
      identity_version: 1,
      full_name: `${user.name} ${user.surname}`,
      job: user.job,
      organization: user.organization,
      test_slug: revision.slug,
      test_title: revision.title,
      locale: 'ru',
      localized_test_title: revision.title,
      score,
      total: variant.question_count,
      pass_score: revision.pass_score,
      best_completed_at: completedAt,
      issued_at: '2026-08-18T08:00:00.000Z',
      issued_by: admin.id,
      issue_source: 'manual',
      template_version: 1,
      revoked_at: revoked ? '2026-08-18T09:00:00.000Z' : null,
      revoked_by: revoked ? admin.id : null,
      revoke_reason: revoked ? 'Тестовый отзыв для проверки рабочего места' : null,
    });
  }
  must(
    'upsert attempts',
    await supabase
      .from('test_attempts')
      .upsert(attempts, { onConflict: 'id', ignoreDuplicates: true }),
  );
  must(
    'upsert attestations',
    await supabase
      .from('attestations')
      .upsert(attestations, { onConflict: 'id', ignoreDuplicates: true }),
  );
  if (certificates.length) {
    must(
      'upsert certificates',
      await supabase
        .from('certificates')
        .upsert(certificates, { onConflict: 'id', ignoreDuplicates: true }),
    );
  }
}

console.log(
  JSON.stringify(
    {
      runId: randomUUID(),
      users: users.length,
      participants: participants.length,
      adminEmail: admin.email,
      participantEmail: participants[0].email,
      companies: companies.length,
      revisions: revisions.length,
    },
    null,
    2,
  ),
);
