// Re-publish an immutable archived revision through the normal draft and publication RPCs.
// Deliberately local-only until a separately reviewed production database transport exists.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validateTarget({ target, course, revision, expectedCurrent }, url, databaseUrl) {
  assert.equal(target, 'local', 'LOCAL_TARGET_REQUIRED');
  assert(['localhost', '127.0.0.1'].includes(new URL(url).hostname), 'LOCAL_API_REQUIRED');
  assert.equal(
    databaseUrl,
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    'LOCAL_DATABASE_REQUIRED',
  );
  for (const id of [course, revision, expectedCurrent]) assert(uuid.test(id), 'UUID_REQUIRED');
}
export async function restoreRevision(options) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const dbUrl =
    process.env.SAFETYHUB_LOCAL_DATABASE_URL ??
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  validateTarget(options, url, dbUrl);
  const db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  try {
    const row = async (sql, args) => (await db.query(sql, args)).rows[0];
    const rows = async (sql, args) => (await db.query(sql, args)).rows;
    const current = await row('select id,slug,current_revision_id from public.tests where id=$1', [
      options.course,
    ]);
    assert.equal(
      current?.current_revision_id,
      options.expectedCurrent,
      'CURRENT_REVISION_CONFLICT',
    );
    const source = await row(
      'select * from public.test_revisions where id=$1 and test_id=$2 and published_at is not null',
      [options.revision, options.course],
    );
    assert(source, 'ARCHIVED_REVISION_NOT_OWNED_BY_COURSE');
    const bank = (
      await row('select private.course_draft_bank_from_revision($1) as bank', [source.id])
    ).bank;
    const locales = await rows(
      'select * from public.test_revision_localizations where revision_id=$1 order by locale',
      [source.id],
    );
    assert.deepEqual(
      locales.map((l) => l.locale).sort(),
      ['en', 'kk', 'ru', 'zh'],
      'FOUR_LOCALES_REQUIRED',
    );
    const mappings = await rows(
      "select m.locale,m.presentation_id,p.sha256 from public.test_revision_presentations m join public.course_presentations p on p.id=m.presentation_id where m.revision_id=$1 and p.course_id=$2 and p.status='ready' order by m.locale",
      [source.id, options.course],
    );
    assert.equal(mappings.length, 4, 'FOUR_READY_PRESENTATIONS_REQUIRED');
    const translations = await rows(
      'select v.stable_id,v.variant_number,l.locale,l.questions,l.explanations from public.test_revision_variant_localizations l join public.test_revision_variants v on v.id=l.variant_id where l.revision_id=$1 order by l.locale,v.variant_number',
      [source.id],
    );
    assert.equal(translations.length, 12, 'TWELVE_VARIANT_TRANSLATIONS_REQUIRED');
    const draft = await row(
      'select draft_version,content_hash from public.course_drafts where test_id=$1',
      [options.course],
    );
    const draftLocales = await rows(
      'select locale,draft_version,content_hash from public.course_draft_localizations where test_id=$1 order by locale',
      [options.course],
    );
    const planHash = digest({
      target: options.target,
      current,
      source,
      bank,
      locales,
      mappings,
      translations,
      draft,
      draftLocales,
    });
    if (!options.apply)
      return {
        planHash,
        course: current.id,
        archivedRevision: source.id,
        expectedCurrent: current.current_revision_id,
        locales: 4,
      };
    assert.equal(options.confirmHash, planHash, 'CONFIRMED_PLAN_HASH_REQUIRED');
    const secret = process.env.SUPABASE_SECRET_KEY;
    const service = createClient(url, secret, { auth: { persistSession: false } });
    const link = await service.auth.admin.generateLink({
      type: 'magiclink',
      email: 'admin@safetyhub.local',
    });
    assert.ifError(link.error);
    const verified = await service.auth.verifyOtp({
      token_hash: link.data.properties.hashed_token,
      type: 'magiclink',
    });
    assert.ifError(verified.error);
    const actor = verified.data.user.id;
    const operator = createClient(url, secret, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${verified.data.session.access_token}` } },
    });
    const rpc = async (client, name, args) => {
      const r = await client.rpc(name, args);
      const error = r.error ?? r.data?.__safetyhubRpcError;
      assert(!error, `${name}:${error?.message}`);
      return r.data;
    };
    const checkCurrent = async () =>
      assert.equal(
        (await row('select current_revision_id from public.tests where id=$1', [current.id]))
          .current_revision_id,
        options.expectedCurrent,
        'CURRENT_REVISION_CONFLICT',
      );
    await checkCurrent();
    await rpc(operator, 'save_course_draft_v3', {
      p_actor_id: actor,
      p_test_id: current.id,
      p_expected_version: draft.draft_version,
      p_slug: current.slug,
      p_title: source.title,
      p_description: source.description,
      p_icon: source.icon,
      p_display_order: source.display_order,
      p_presentation_id: source.presentation_id,
      p_duration_minutes: source.duration_minutes,
      p_pass_score: source.pass_score,
      p_attempts_per_calendar_day: source.attempts_per_calendar_day,
      p_attempt_reset_timezone: source.attempt_reset_timezone,
      p_question_variants: bank,
      p_seo: source.seo,
      p_content_metadata: {
        jurisdiction: source.jurisdiction,
        effectiveDate:
          source.effective_date instanceof Date
            ? source.effective_date.toISOString().slice(0, 10)
            : source.effective_date,
        sources: source.sources,
      },
    });
    // Use a separate service client: verifyOtp above must not change the service-role transport.
    const importer = createClient(url, secret, { auth: { persistSession: false } });
    for (const locale of locales) {
      await checkCurrent();
      const getDraft = () =>
        row('select * from public.course_draft_localizations where test_id=$1 and locale=$2', [
          current.id,
          locale.locale,
        ]);
      let loc = await getDraft();
      const args = () => ({
        p_actor_id: actor,
        p_test_id: current.id,
        p_locale: locale.locale,
        p_expected_version: loc?.draft_version ?? null,
        p_title: locale.title,
        p_description: locale.description,
        p_content: locale.content,
        p_question_variants: [],
        p_seo: locale.seo,
        p_sources: locale.sources,
        p_reviewed_content_hash: null,
        p_translation_qa: {
          ...locale.translation_qa,
          status: locale.locale === 'ru' ? 'source' : locale.translation_qa.status,
        },
        p_presentation_id: mappings.find((m) => m.locale === locale.locale).presentation_id,
      });
      await rpc(operator, 'save_course_localization_draft', args());
      loc = await getDraft();
      if (locale.locale !== 'ru') {
        const variants = translations
          .filter((v) => v.locale === locale.locale)
          .map((v) => ({
            id: v.stable_id,
            variantNumber: v.variant_number,
            questions: v.questions.map((q, i) => ({
              id: q.id,
              text: q.text,
              displayOrder: q.position,
              explanation: v.explanations[i],
              options: q.options.map((o) => ({ id: o.id, text: o.text, displayOrder: o.position })),
            })),
          }));
        await rpc(importer, 'import_course_assessment_localization', {
          p_actor_id: actor,
          p_test_id: current.id,
          p_locale: locale.locale,
          p_expected_version: loc.draft_version,
          p_question_variants: variants,
        });
        loc = await getDraft();
      }
      await rpc(operator, 'save_course_localization_draft', {
        ...args(),
        p_reviewed_content_hash: loc.content_hash,
        p_translation_qa: {
          ...locale.translation_qa,
          status: locale.locale === 'ru' ? 'source' : locale.translation_qa.status,
        },
      });
    }
    await checkCurrent();
    const finalDraft = await row('select content_hash from public.course_drafts where test_id=$1', [
      current.id,
    ]);
    const result = await rpc(operator, 'publish_course_revision_v4', {
      p_actor_id: actor,
      p_test_id: current.id,
      p_expected_content_hash: finalDraft.content_hash,
    });
    assert.notEqual(result.revisionId, source.id, 'IMMUTABLE_HISTORY_REQUIRED');
    return { status: 'published', planHash, restoredFromRevision: source.id, ...result };
  } finally {
    await db.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')),
  );
  restoreRevision({
    target: args.target,
    course: args.course,
    revision: args.revision,
    expectedCurrent: args['expected-current'],
    apply: 'apply' in args,
    confirmHash: args['confirm-hash'],
  })
    .then((r) => console.log(JSON.stringify(r)))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
}
