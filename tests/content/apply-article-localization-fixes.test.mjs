import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArguments,
  planArticle,
  readFixes,
  verifyArticle,
} from '../../scripts/content/apply-article-localization-fixes.mjs';

const LOCALES = ['ru', 'kk', 'en', 'zh'];
const seo = (text) => ({
  title: `${text} title`,
  description: `${text} description that is long enough for the schema limits.`,
  ogTitle: `${text} title`,
  ogDescription: `${text} description that is long enough for the schema limits.`,
  ogImage: '',
  indexable: true,
});
const localization = (locale) => ({
  locale,
  title: `Title ${locale}`,
  description: `Description ${locale}`,
  blocks: [{ type: 'paragraph', text: locale }],
  seo: seo(locale),
  sources: [],
});

// A published article whose drafts equal the live revision.
function rows() {
  const live = LOCALES.map(localization);
  return {
    article: {
      id: 'a1',
      slug: 'demo',
      status: 'published',
      is_published: true,
      current_revision_id: 'r1',
      content_version: 2,
    },
    revision: { id: 'r1', version: 2, content_hash: 'h-live' },
    localizations: live.map((row) => ({ ...row, content_hash: `h-${row.locale}` })),
    draft: { article_id: 'a1', content_hash: 'h-live', draft_version: 3 },
    draftLocalizations: live.map((row) => ({
      ...structuredClone(row),
      status: 'complete',
      draft_version: 4,
      content_hash: `h-${row.locale}`,
      reviewed_content_hash: `h-${row.locale}`,
      translation_qa: { status: 'passed' },
    })),
  };
}
const fix = (locale, field, from, to) => ({
  type: 'article',
  slug: 'demo',
  locale,
  field,
  from,
  to,
});

test('only article entries are read; bad entries are refused by name', () => {
  const { bySlug, skipped, errors } = readFixes([
    fix('kk', 'description', 'Description kk', 'Сипаттама'),
    { type: 'course', slug: 'biot', locale: 'kk', field: 'presentation.text', from: 'a', to: 'b' },
    fix('ru', 'description', 'x', 'y'),
    fix('en', 'title', 'x', 'y'),
    fix('kk', 'description', 'again', 'twice'),
  ]);
  assert.equal(bySlug.get('demo').length, 1);
  assert.deepEqual(skipped, ['course:biot:kk:presentation.text']);
  assert.match(errors.join(), /FIX_LOCALE_INVALID/u);
  assert.match(errors.join(), /FIX_FIELD_INVALID/u);
  assert.match(errors.join(), /FIX_DUPLICATE/u);
});

test('a fix applies to the published value and leaves every other text alone', () => {
  const plan = planArticle({
    rows: rows(),
    fixes: [
      fix('kk', 'description', 'Description kk', 'Түзетілген сипаттама'),
      fix('en', 'seo.ogTitle', 'en title', 'Better en title'),
    ],
  });
  assert.equal(plan.ok, true, plan.errors.join());
  assert.equal(plan.next.kk.description, 'Түзетілген сипаттама');
  assert.equal(plan.next.en.seo.ogTitle, 'Better en title');
  assert.equal(plan.next.en.seo.title, 'en title');
  assert.deepEqual(plan.next.zh, plan.live.zh);
  assert.deepEqual(plan.saves, ['kk', 'en']);
  assert.equal(plan.publishNeeded, true);
  assert.deepEqual(plan.blockers, []);
});

test('refuses when the published value is neither `from` nor `to`, and when the SEO would break', () => {
  const moved = planArticle({
    rows: rows(),
    fixes: [fix('kk', 'description', 'something older', 'new')],
  });
  assert.match(moved.errors.join(), /FROM_MISMATCH:kk:description/u);
  const short = planArticle({
    rows: rows(),
    fixes: [fix('zh', 'seo.description', seo('zh').description, 'too short')],
  });
  assert.match(short.errors.join(), /SEO_INVALID:zh:description/u);

  // A description the live site already has under the editor's floor may stay under it.
  const legacy = rows();
  legacy.localizations.find((l) => l.locale === 'zh').seo.description = '已经很短的描述';
  const kept = planArticle({
    rows: legacy,
    fixes: [fix('zh', 'seo.description', '已经很短的描述', '更正后的短描述')],
  });
  assert.equal(kept.ok, true, kept.errors.join());
  assert.match(kept.warnings.join(), /SEO_ALREADY_OUTSIDE_EDITOR_RULES:zh:description/u);
});

test('an already published fix is a no-op', () => {
  const state = rows();
  state.localizations.find((l) => l.locale === 'kk').description = 'Done';
  state.draftLocalizations.find((l) => l.locale === 'kk').description = 'Done';
  const plan = planArticle({
    rows: state,
    fixes: [fix('kk', 'description', 'Description kk', 'Done')],
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.publishNeeded, false);
  assert.deepEqual(plan.saves, []);
});

test('unpublished draft work blocks, or is kept or discarded on request', () => {
  const state = rows();
  state.draftLocalizations.find((l) => l.locale === 'zh').title = 'Draft zh title';
  const fixes = [fix('kk', 'description', 'Description kk', 'Жаңа')];
  assert.match(
    planArticle({ rows: state, fixes }).blockers.join(),
    /PENDING_DRAFT_DECISION_REQUIRED:zh:title/u,
  );
  const kept = planArticle({ rows: state, fixes, pendingDraft: 'publish' });
  assert.equal(kept.next.zh.title, 'Draft zh title');
  assert.deepEqual(kept.blockers, []);
  const dropped = planArticle({ rows: state, fixes, pendingDraft: 'discard' });
  assert.equal(dropped.next.zh.title, 'Title zh');
  assert.ok(dropped.saves.includes('zh'));

  const ru = rows();
  ru.draft.content_hash = 'h-draft';
  assert.match(
    planArticle({ rows: ru, fixes }).blockers.join(),
    /ARTICLE_DRAFT_HAS_UNPUBLISHED_CHANGES/u,
  );

  const clash = rows();
  clash.draftLocalizations.find((l) => l.locale === 'kk').description = 'Someone else';
  assert.match(
    planArticle({ rows: clash, fixes, pendingDraft: 'publish' }).errors.join(),
    /PENDING_DRAFT_CONFLICT/u,
  );
});

test('the re-read revision must carry the intended texts and an untouched Russian', () => {
  const before = rows();
  const plan = planArticle({
    rows: before,
    fixes: [fix('kk', 'description', 'Description kk', 'Жаңа')],
  });
  const after = structuredClone(before);
  after.article.current_revision_id = 'r2';
  after.revision = { id: 'r2', version: 3, content_hash: 'h-live' };
  after.localizations.find((l) => l.locale === 'kk').description = 'Жаңа';
  assert.deepEqual(verifyArticle({ before, plan, afterRows: after }), []);
  after.localizations.find((l) => l.locale === 'ru').title = 'Иначе';
  after.localizations.find((l) => l.locale === 'en').seo.title = 'Lost';
  assert.deepEqual(verifyArticle({ before, plan, afterRows: after }), [
    'RU_CHANGED',
    'NOT_AS_INTENDED:en',
  ]);
});

test('arguments', () => {
  const parsed = parseArguments(['--fixes=f.json', '--target=production', '--plan', '--slug=demo']);
  assert.equal(parsed.slug, 'demo');
  assert.equal(parsed.mode, 'plan');
  assert.throws(() => parseArguments(['--target=local', '--plan']), /FIXES_REQUIRED/u);
});
