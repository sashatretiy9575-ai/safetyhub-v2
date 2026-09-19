// Give every language of a published course its own wording for the legal acts it cites.
//
// The batch importer writes the sources that ship with each deck, but the two courses of
// September 2026 were published before the kk/en/zh decks had translated titles, so their
// live localizations still carry the Russian list. This script closes that gap on a database
// that is already published, through the same RPCs the course editor uses: it saves the
// localization draft and publishes one new revision per course. Nothing else is touched —
// titles, descriptions, SEO, assessments and presentations are written back unchanged.
//
//   node --env-file=.env.local scripts/localize-course-sources.mjs --target=local
//   node --env-file=.env.local scripts/localize-course-sources.mjs --target=local --apply
//
// Without --apply it only prints the plan. A second run after --apply prints `changes: 0`.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createSupabaseRepository } from './publish-stage6-localizations.mjs';
import { COURSE_BATCH_SLUGS, operatorSession } from './publish-course-batch.mjs';
import {
  CURRENT_PRODUCTION_PROJECT_REF,
  assertLinkedProductionProjectRef,
} from './production-operator-safety.mjs';

const ROOT = path.resolve('content/course-batch-2026-09');
const TRANSLATED_LOCALES = ['kk', 'en', 'zh'];

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

// jsonb keeps object keys in its own order, so a source list is compared by its content.
const sourceKey = (sources) =>
  JSON.stringify(
    (sources ?? []).map(({ title, url }) => `${title}\n${url}`).sort(),
  );
const sameSources = (a, b) => sourceKey(a) === sourceKey(b);

/** The published projection of a deck's sources: linked entries only, sorted by title. */
export function deckSources(deck) {
  return deck.sources
    .filter((source) => source.url && source.title)
    .map(({ title, url }) => ({ title, url }))
    .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
}

function flag(name) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? null;
}

export async function localizeCourseSources({ apply, target, operatorEmail, root = ROOT }) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  assert(url && secret, 'ENVIRONMENT_REQUIRED');
  const host = new URL(url).hostname;
  const local = ['127.0.0.1', 'localhost'].includes(host);
  assert(target === (local ? 'local' : 'production'), 'TARGET_MISMATCH');
  if (!local) {
    assert(host === `${CURRENT_PRODUCTION_PROJECT_REF}.supabase.co`, 'PRODUCTION_TARGET_MISMATCH');
    await assertLinkedProductionProjectRef(CURRENT_PRODUCTION_PROJECT_REF);
  }

  const wanted = new Map();
  for (const slug of COURSE_BATCH_SLUGS)
    for (const locale of TRANSLATED_LOCALES) {
      const deck = JSON.parse(await readFile(path.join(root, slug, locale, 'deck.json'), 'utf8'));
      assert(deck.slug === slug && deck.locale === locale, 'DECK_IDENTITY_INVALID');
      const sources = deckSources(deck);
      assert(sources.length === 5, 'DECK_SOURCES_UNEXPECTED');
      wanted.set(`${slug}:${locale}`, sources);
    }

  const service = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { token, actorId } = await operatorSession(service, url, secret, local, operatorEmail);
  const repo = createSupabaseRepository({
    url,
    serviceSecret: secret,
    operatorAccessToken: token,
    root: process.cwd(),
    batchHash: 'localize-course-sources',
  });
  await repo.assertOperator(actorId);

  const catalog = await service.from('tests').select('id,slug').in('slug', COURSE_BATCH_SLUGS);
  assert(!catalog.error && catalog.data.length === COURSE_BATCH_SLUGS.length, 'CATALOG_READ_FAILED');

  const plan = [];
  let changes = 0;
  for (const slug of COURSE_BATCH_SLUGS) {
    const courseId = catalog.data.find((course) => course.slug === slug).id;
    let state = await repo.readCourse(courseId);
    const pending = [];
    for (const locale of TRANSLATED_LOCALES) {
      const sources = wanted.get(`${slug}:${locale}`);
      const draft = state.draftLocalizations.find((row) => row.locale === locale);
      const live = state.current?.localizations.find((row) => row.locale === locale);
      assert(draft, `DRAFT_LOCALIZATION_MISSING:${slug}:${locale}`);
      const draftMatches = sameSources(draft.sources, sources) && draft.status === 'complete';
      const liveMatches = Boolean(live) && sameSources(live.sources, sources);
      plan.push({
        slug,
        locale,
        draftMatches,
        liveMatches,
        from: (live?.sources ?? draft.sources ?? []).map((source) => source.title),
        to: sources.map((source) => source.title),
      });
      if (!draftMatches || !liveMatches) pending.push({ locale, sources, draftMatches });
    }
    if (pending.length === 0) continue;
    changes += pending.length;
    if (!apply) continue;

    for (const { locale, sources, draftMatches } of pending) {
      if (draftMatches) continue;
      let draft = state.draftLocalizations.find((row) => row.locale === locale);
      const presentationId = state.draftMappings.find(
        (row) => row.locale === locale,
      )?.presentation_id;
      assert(presentationId, `PRESENTATION_MAPPING_MISSING:${slug}:${locale}`);
      // Everything except the sources is written back exactly as it already stands.
      const args = (expectedVersion, reviewedContentHash, translationQa) => ({
        p_actor_id: actorId,
        p_test_id: courseId,
        p_locale: locale,
        p_expected_version: expectedVersion,
        p_title: draft.title,
        p_description: draft.description,
        p_content: draft.content,
        p_question_variants: [],
        p_seo: draft.seo,
        p_sources: sources,
        p_reviewed_content_hash: reviewedContentHash,
        p_translation_qa: translationQa,
        p_presentation_id: presentationId,
      });
      const qa = { ...draft.translation_qa, status: 'passed', sourceTitlesLocalized: true };
      // The hash of the new wording is only known once the row exists, so the row is written
      // twice: the first call stores it, the second marks the very same hash as reviewed.
      if (!sameSources(draft.sources, sources)) {
        await repo.saveCourseLocalization(args(draft.draft_version, null, qa));
        state = await repo.readCourse(courseId);
        draft = state.draftLocalizations.find((row) => row.locale === locale);
      }
      assert(sameSources(draft.sources, sources), `SOURCES_NOT_STORED:${slug}:${locale}`);
      await repo.saveCourseLocalization(args(draft.draft_version, draft.content_hash, qa));
      state = await repo.readCourse(courseId);
      draft = state.draftLocalizations.find((row) => row.locale === locale);
      assert(draft.status === 'complete', `LOCALIZATION_NOT_COMPLETE:${slug}:${locale}`);
    }

    state = await repo.readCourse(courseId);
    const published = await repo.publishCourse({
      p_actor_id: actorId,
      p_test_id: courseId,
      p_expected_content_hash: state.draft.content_hash,
    });
    assert(published.locales?.length === 4, 'PUBLICATION_RECEIPT_INVALID');
    state = await repo.readCourse(courseId);
    for (const locale of TRANSLATED_LOCALES)
      assert(
        sameSources(
          state.current?.localizations.find((row) => row.locale === locale)?.sources,
          wanted.get(`${slug}:${locale}`),
        ),
        `LIVE_SOURCES_MISMATCH:${slug}:${locale}`,
      );
  }
  return { target, apply, changes, plan };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = flag('target');
  assert(target === 'local' || target === 'production', 'TARGET_REQUIRED');
  const receipt = await localizeCourseSources({
    apply: process.argv.includes('--apply'),
    target,
    operatorEmail: flag('operator-email'),
  });
  console.log(JSON.stringify(receipt, null, 2));
}
