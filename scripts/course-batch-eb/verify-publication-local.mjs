// What the LOCAL database actually holds after the electrical-safety course is
// published: the course itself, its four languages, the presentation bytes and
// the questions — and that nothing a learner can read carries an answer key.
// Read-only; refuses any host but the local stand.
//
//   node --env-file=.env.local scripts/course-batch-eb/verify-publication-local.mjs
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { SLUG } from './author-assessment-ru.mjs';

const LOCALES = ['ru', 'kk', 'en', 'zh'];
const ROOT = path.resolve('content/course-batch-2026-09-eb', SLUG);
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) throw new Error('ENVIRONMENT_REQUIRED');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('LOCAL_STAND_ONLY');
const service = createClient(url, secret, { auth: { persistSession: false } });
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

const course = await service
  .from('tests')
  .select('id,slug,title,status,icon,current_revision_id')
  .eq('slug', SLUG)
  .maybeSingle();
if (course.error) throw course.error;
check(Boolean(course.data), 'the course is not in the catalogue');
if (!course.data) {
  console.log(JSON.stringify({ ok: false, failures }));
  process.exit(1);
}
check(course.data.status === 'published', `the course is ${course.data.status}`);
check(course.data.icon === 'lightning', `the icon is ${course.data.icon}`);
check(Boolean(course.data.current_revision_id), 'the course has no published revision');

const revision = await service
  .from('test_revisions')
  .select('id,question_count,pass_score,duration_minutes')
  .eq('id', course.data.current_revision_id)
  .single();
if (revision.error) throw revision.error;
check(revision.data.question_count === 10, `questions per attempt: ${revision.data.question_count}`);
check(revision.data.pass_score === 7, `pass score: ${revision.data.pass_score}`);

// Every variant holds its ten questions of four options, and the key to them is
// nowhere in the table a reader could reach.
const variants = await service
  .from('test_revision_variants')
  .select('variant_number,questions,question_count')
  .eq('revision_id', revision.data.id)
  .order('variant_number');
if (variants.error) throw variants.error;
check(variants.data.length === 3, `variants: ${variants.data.length}`);
for (const variant of variants.data) {
  check(
    variant.question_count === 10,
    `variant ${variant.variant_number}: ${variant.question_count} questions`,
  );
  const questions = Array.isArray(variant.questions) ? variant.questions : [];
  check(questions.length === 10, `variant ${variant.variant_number}: ${questions.length} stored`);
  check(
    questions.every((question) => question.text && question.options?.length === 4),
    `variant ${variant.variant_number}: a question lost its options`,
  );
  check(
    !JSON.stringify(questions).includes('correctOptionId'),
    `variant ${variant.variant_number}: the answer key sits beside the questions`,
  );
}

const localizations = await service
  .from('test_revision_localizations')
  .select('locale,title,description,seo,translation_qa,published_at')
  .eq('revision_id', revision.data.id);
if (localizations.error) throw localizations.error;
for (const locale of LOCALES) {
  const row = localizations.data.find((entry) => entry.locale === locale);
  check(Boolean(row), `no ${locale} localization`);
  if (!row) continue;
  const deck = JSON.parse(await readFile(path.join(ROOT, locale, 'deck.json'), 'utf8'));
  check(row.title === deck.title, `${locale}: title is ${JSON.stringify(row.title)}`);
  check(row.description === deck.description, `${locale}: description differs from the deck`);
  check(row.seo?.ogImage === deck.seo.ogImage, `${locale}: ogImage is ${row.seo?.ogImage}`);
  check(Boolean(row.published_at), `${locale}: the localization is not published`);
  // Russian is the source the others are translated from; only they carry QA.
  if (locale !== 'ru')
    check(
      row.translation_qa?.status === 'passed',
      `${locale}: translation QA ${row.translation_qa?.status}`,
    );
}

// A course that has been published twice holds the presentation of each
// publication, so the file a reader is served is the one this revision names,
// not merely one that is ready.
const mapping = await service
  .from('test_revision_presentations')
  .select('locale,presentation_id')
  .eq('revision_id', revision.data.id);
if (mapping.error) throw mapping.error;
const presentations = await service
  .from('course_presentations')
  .select('id,locale,status,sha256,page_count,byte_size,storage_bucket,storage_path')
  .in(
    'id',
    mapping.data.map((entry) => entry.presentation_id),
  );
if (presentations.error) throw presentations.error;
for (const locale of LOCALES) {
  const row = presentations.data.find(
    (entry) => entry.locale === locale && entry.status === 'ready',
  );
  check(Boolean(row), `no ready ${locale} presentation`);
  if (!row) continue;
  const bytes = await readFile(path.join(ROOT, locale, 'presentation.pdf'));
  check(
    row.sha256 === createHash('sha256').update(bytes).digest('hex'),
    `${locale}: the stored presentation is not the reviewed file`,
  );
  check(row.page_count === 59, `${locale}: ${row.page_count} pages`);
  check(Number(row.byte_size) === bytes.length, `${locale}: ${row.byte_size} bytes stored`);
  const stored = await service.storage.from(row.storage_bucket).download(row.storage_path);
  check(!stored.error, `${locale}: the presentation is not in the bucket`);
  if (!stored.error)
    check(
      createHash('sha256')
        .update(new Uint8Array(await stored.data.arrayBuffer()))
        .digest('hex') === row.sha256,
      `${locale}: the bucket holds other bytes`,
    );
}

console.log(
  JSON.stringify(
    {
      ok: failures.length === 0,
      course: course.data.id,
      variants: variants.data.length,
      locales: localizations.data.map((row) => row.locale).sort(),
      failures,
    },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
