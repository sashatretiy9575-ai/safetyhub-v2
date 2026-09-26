// Publish reviewed corrections to the kk/en/zh texts of published articles.
//
// Usage:
//   node --env-file=.env.local scripts/content/apply-article-localization-fixes.mjs \
//     --fixes=<fixes.json> --target=local|production (--plan|--apply) \
//     [--slug=<one article>] [--confirm-hash=<sha256 of --fixes>] \
//     [--pending-draft=publish|discard] [--operator-email=<admin e-mail>]
//
// The fixes file is a list of {type:"article", slug, locale: kk|en|zh, field, from, to}; field is
// description, seo.title, seo.ogTitle, seo.description or seo.ogDescription. Entries of any
// other type are listed and skipped. A fix applies only while the PUBLISHED value still equals
// `from` (one already equal to `to` counts as done); anything else refuses the whole run, as
// does an SEO block the admin editor's own schema would reject, or a Russian draft carrying
// unpublished work. Unpublished kk/en/zh edits in a touched article are a decision, exactly as
// in apply-option-rewrite: --pending-draft=publish keeps them, =discard resets them to live.
//
// It writes like the admin article localization editor (server/admin/localizations.ts):
// save_article_localization_draft without, then with, the reviewed hash the database computed,
// then publish_article_revision_v3 for all four locales. Every article is validated before
// the first write; after publishing, each is re-read and checked against what was intended.
// Public pages pick the change up within the 5-minute content revalidation window.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { contentSeoSchema } from '../../lib/validation/content-seo.ts';
import {
  ContentFixError,
  TRANSLATED,
  clean,
  connectTarget,
  isObject,
  operatorRepository,
  parseCommonArguments,
  runCli,
  sameJson,
  sha256,
  textProblem,
} from './content-fix-common.mjs';

export const ARTICLE_FIELDS = ['title', 'description', 'blocks', 'seo', 'sources'];
export const FIXABLE_FIELDS = [
  'description',
  'seo.title',
  'seo.ogTitle',
  'seo.description',
  'seo.ogDescription',
];
const DESCRIPTION_MAX = 2000;

const readField = (localization, field) =>
  field.split('.').reduce((value, key) => (isObject(value) ? value[key] : undefined), localization);
function writeField(localization, field, value) {
  const [head, key] = field.split('.');
  if (key) localization[head] = { ...localization[head], [key]: value };
  else localization[head] = value;
}
const pick = (row) => Object.fromEntries(ARTICLE_FIELDS.map((key) => [key, row?.[key]]));

/** Article entries grouped by slug, the skipped rest, and shape errors. */
export function readFixes(entries, onlySlug = null) {
  const errors = [];
  if (!Array.isArray(entries))
    return { bySlug: new Map(), skipped: [], errors: ['FIXES_SHAPE_INVALID'] };
  const bySlug = new Map();
  const skipped = [];
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    if (entry?.type !== 'article') {
      skipped.push(`${entry?.type}:${entry?.slug}:${entry?.locale}:${entry?.field}`);
      continue;
    }
    if (onlySlug && entry.slug !== onlySlug) continue;
    const where = `#${index}:${entry.slug}:${entry.locale}:${entry.field}`;
    if (typeof entry.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.slug))
      errors.push(`FIX_SLUG_INVALID:${where}`);
    else if (!TRANSLATED.includes(entry.locale)) errors.push(`FIX_LOCALE_INVALID:${where}`);
    else if (!FIXABLE_FIELDS.includes(entry.field)) errors.push(`FIX_FIELD_INVALID:${where}`);
    else if (typeof entry.from !== 'string') errors.push(`FIX_FROM_INVALID:${where}`);
    else if (textProblem(entry.to, DESCRIPTION_MAX))
      errors.push(`${textProblem(entry.to, DESCRIPTION_MAX)}:${where}`);
    else if (seen.has(`${entry.slug}:${entry.locale}:${entry.field}`))
      errors.push(`FIX_DUPLICATE:${where}`);
    else {
      seen.add(`${entry.slug}:${entry.locale}:${entry.field}`);
      if (!bySlug.has(entry.slug)) bySlug.set(entry.slug, []);
      bySlug.get(entry.slug).push(entry);
    }
  }
  if (onlySlug && !bySlug.has(onlySlug) && errors.length === 0)
    errors.push(`FIX_SLUG_UNKNOWN:${onlySlug}`);
  return { bySlug, skipped, errors };
}

/** What one article's fixes change, the four texts it will publish, and what blocks it. */
export function planArticle({ rows, fixes, pendingDraft = null }) {
  const errors = [];
  const { article, revision, localizations, draft, draftLocalizations } = rows;
  if (
    article.status !== 'published' ||
    !article.is_published ||
    revision?.id !== article.current_revision_id
  )
    errors.push('ARTICLE_NOT_PUBLISHED');
  const live = {};
  for (const locale of ['ru', ...TRANSLATED]) {
    const row = localizations.find((item) => item.locale === locale);
    if (!row) errors.push(`LOCALE_NOT_PUBLISHED:${locale}`);
    live[locale] = pick(row);
  }
  const drafted = Object.fromEntries(
    TRANSLATED.map((locale) => [locale, draftLocalizations.find((item) => item.locale === locale)]),
  );
  const next = Object.fromEntries(
    TRANSLATED.map((locale) => [
      locale,
      structuredClone(
        pendingDraft === 'publish' && drafted[locale] ? pick(drafted[locale]) : live[locale],
      ),
    ]),
  );
  const changes = [];
  for (const fix of fixes) {
    const where = `${fix.locale}:${fix.field}`;
    const published = readField(live[fix.locale], fix.field);
    const state =
      clean(published) === clean(fix.from)
        ? 'change'
        : clean(published) === clean(fix.to)
          ? 'applied'
          : null;
    if (!state) {
      errors.push(`FROM_MISMATCH:${where}`);
      continue;
    }
    // A kept draft that changed the very field being fixed is a conflict, not a merge.
    const kept = readField(next[fix.locale], fix.field);
    if (clean(kept) !== clean(published) && clean(kept) !== clean(fix.to)) {
      errors.push(`PENDING_DRAFT_CONFLICT:${where}`);
      continue;
    }
    writeField(next[fix.locale], fix.field, clean(fix.to));
    changes.push({ locale: fix.locale, field: fix.field, state });
  }
  const warnings = [];
  for (const locale of new Set(fixes.map((fix) => fix.locale))) {
    // The admin editor's SEO schema: a fix may not break a rule the live text keeps. Some
    // imported zh descriptions are already under its 40-character floor; staying there is
    // reported, not refused, since the editor could not save them either.
    const issues = (seo) =>
      new Set(
        (contentSeoSchema.safeParse(seo).error?.issues ?? []).map(
          (i) => `${i.path.join('.')}:${i.code}`,
        ),
      );
    const before = issues(live[locale].seo);
    const after = [...issues(next[locale].seo)];
    const introduced = after.filter((issue) => !before.has(issue));
    if (introduced.length) errors.push(`SEO_INVALID:${locale}:${introduced.join('+')}`);
    if (after.length > introduced.length)
      warnings.push(
        `SEO_ALREADY_OUTSIDE_EDITOR_RULES:${locale}:${after.filter((i) => before.has(i)).join('+')}`,
      );
    if ([...(next[locale].description ?? '')].length > DESCRIPTION_MAX)
      errors.push(`TEXT_TOO_LONG:${locale}:description`);
  }
  // Draft against live (clean), against exactly these fixes (in-progress), or neither.
  const inspection = {
    ru: draft.content_hash === revision?.content_hash ? 'clean' : 'foreign',
    locales: {},
  };
  const blockers = [];
  if (inspection.ru === 'foreign') blockers.push('ARTICLE_DRAFT_HAS_UNPUBLISHED_CHANGES');
  for (const locale of TRANSLATED) {
    const row = drafted[locale];
    const fields = row ? pick(row) : null;
    const state = !row
      ? 'missing'
      : sameJson(fields, live[locale])
        ? 'clean'
        : sameJson(fields, next[locale])
          ? 'in-progress'
          : 'pending';
    inspection.locales[locale] = {
      state,
      status: row?.status ?? null,
      ...(state === 'pending'
        ? { fields: ARTICLE_FIELDS.filter((k) => !sameJson(fields[k], live[locale][k])) }
        : {}),
    };
    if (state === 'missing') blockers.push(`DRAFT_LOCALIZATION_MISSING:${locale}`);
    if (state === 'pending' && !pendingDraft)
      blockers.push(
        `PENDING_DRAFT_DECISION_REQUIRED:${locale}:${inspection.locales[locale].fields.join('+')} (--pending-draft=publish|discard)`,
      );
  }
  const saves = TRANSLATED.filter((locale) => {
    const row = drafted[locale];
    return (
      !row ||
      !sameJson(pick(row), next[locale]) ||
      row.status !== 'complete' ||
      row.reviewed_content_hash !== row.content_hash
    );
  });
  const publishNeeded = TRANSLATED.some((locale) => !sameJson(next[locale], live[locale]));
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    changes,
    next,
    live,
    inspection,
    blockers,
    saves,
    publishNeeded,
  };
}

/** The re-read article: new revision, four locales, the intended texts, Russian untouched. */
export function verifyArticle({ before, plan, afterRows }) {
  const failures = [];
  const { article, revision, localizations, draft } = afterRows;
  if (article.current_revision_id === before.article.current_revision_id)
    failures.push('NEW_REVISION_MISSING');
  if (revision?.version !== before.revision.version + 1)
    failures.push('REVISION_VERSION_UNEXPECTED');
  if (localizations.length !== 4) failures.push('LOCALES_NOT_PUBLISHED');
  if (draft.content_hash !== revision?.content_hash) failures.push('DRAFT_DIFFERS_FROM_LIVE');
  const ru = localizations.find((item) => item.locale === 'ru');
  if (!sameJson(pick(ru), plan.live.ru)) failures.push('RU_CHANGED');
  for (const locale of TRANSLATED) {
    const row = localizations.find((item) => item.locale === locale);
    if (!sameJson(pick(row), plan.next[locale])) failures.push(`NOT_AS_INTENDED:${locale}`);
  }
  return failures;
}

async function readRows(service, slug) {
  const one = async (query, what) => {
    const { data, error } = await query;
    if (error) throw new ContentFixError('TARGET_READ_FAILED', [what, error.message]);
    return data;
  };
  const article = await one(
    service
      .from('articles')
      .select('id,slug,status,is_published,current_revision_id,content_version,content_hash')
      .eq('slug', slug)
      .maybeSingle(),
    'articles',
  );
  if (!article) throw new ContentFixError('ARTICLE_NOT_FOUND', [slug]);
  const [revision, localizations, draft, draftLocalizations] = await Promise.all([
    one(
      service
        .from('article_revisions')
        .select('id,version,content_hash')
        .eq('id', article.current_revision_id)
        .maybeSingle(),
      'article_revisions',
    ),
    one(
      service
        .from('article_revision_localizations')
        .select(`locale,content_hash,translation_qa,${ARTICLE_FIELDS.join(',')}`)
        .eq('revision_id', article.current_revision_id),
      'article_revision_localizations',
    ),
    one(
      service
        .from('article_drafts')
        .select('article_id,content_hash,draft_version')
        .eq('article_id', article.id)
        .maybeSingle(),
      'article_drafts',
    ),
    one(
      service
        .from('article_draft_localizations')
        .select(
          `locale,status,draft_version,content_hash,reviewed_content_hash,translation_qa,${ARTICLE_FIELDS.join(',')}`,
        )
        .eq('article_id', article.id),
      'article_draft_localizations',
    ),
  ]);
  if (!draft) throw new ContentFixError('ARTICLE_DRAFT_NOT_FOUND', [slug]);
  return { article, revision, localizations, draft, draftLocalizations };
}

async function applyArticle({ service, repo, actorId, slug, rows, plan, receipt }) {
  const articleId = rows.article.id;
  let current = rows;
  for (const locale of plan.saves) {
    let row = current.draftLocalizations.find((item) => item.locale === locale);
    const fields = plan.next[locale];
    const args = (reviewed) => ({
      p_actor_id: actorId,
      p_article_id: articleId,
      p_locale: locale,
      p_expected_version: row?.draft_version ?? null,
      p_title: fields.title,
      p_description: fields.description,
      p_blocks: fields.blocks,
      p_seo: fields.seo,
      p_sources: fields.sources,
      p_reviewed_content_hash: reviewed,
      p_translation_qa: {
        ...row?.translation_qa,
        locale,
        status: 'passed',
        localizationFix: receipt,
      },
    });
    // The editor's two steps: store the text, then mark it reviewed at the hash it was given.
    if (!row || !sameJson(pick(row), fields)) {
      await repo.saveArticleLocalization(args(null));
      current = await readRows(service, slug);
      row = current.draftLocalizations.find((item) => item.locale === locale);
    }
    await repo.saveArticleLocalization(args(row.content_hash));
    current = await readRows(service, slug);
    row = current.draftLocalizations.find((item) => item.locale === locale);
    if (row?.status !== 'complete' || row.reviewed_content_hash !== row.content_hash)
      throw new ContentFixError('LOCALIZATION_NOT_COMPLETE', [slug, locale]);
  }
  if (current.article.current_revision_id !== rows.article.current_revision_id)
    throw new ContentFixError('LIVE_REVISION_MOVED', [slug]);
  const published = await repo.publishArticle({
    p_actor_id: actorId,
    p_article_id: articleId,
    p_expected_content_hash: current.draft.content_hash,
  });
  const afterRows = await readRows(service, slug);
  const failures = verifyArticle({ before: rows, plan, afterRows });
  if (afterRows.article.current_revision_id !== published.revisionId)
    failures.push('LIVE_REVISION_NOT_THE_PUBLISHED_ONE');
  if (failures.length)
    throw new ContentFixError('PUBLISHED_REVISION_VERIFICATION_FAILED', [
      `${slug} revision ${published.revisionId} IS live`,
      ...failures,
    ]);
  return { revisionId: published.revisionId, version: afterRows.revision.version, verified: true };
}

export function parseArguments(argv) {
  const options = parseCommonArguments(argv, { names: ['fixes', 'slug'], required: ['fixes'] });
  return { ...options, fixes: path.resolve(options.values.fixes), slug: options.values.slug };
}

export async function run(argv, environment = process.env) {
  const options = parseArguments(argv);
  const bytes = await readFile(options.fixes);
  const fileSha256 = sha256(bytes);
  const {
    bySlug,
    skipped,
    errors: shapeErrors,
  } = readFixes(JSON.parse(bytes.toString('utf8')), options.slug);
  const target = await connectTarget(options, fileSha256, environment);
  const articles = [];
  for (const [slug, fixes] of [...bySlug.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const rows = await readRows(target.service, slug);
    articles.push({
      slug,
      rows,
      plan: planArticle({ rows, fixes, pendingDraft: options.pendingDraft }),
    });
  }
  const errors = [
    ...shapeErrors,
    ...articles.flatMap((a) => a.plan.errors.map((e) => `${a.slug}:${e}`)),
  ];
  const blockers = articles.flatMap((a) => a.plan.blockers.map((b) => `${a.slug}:${b}`));
  const pending = articles.filter((a) => a.plan.ok && a.plan.publishNeeded);
  const report = {
    ok: errors.length === 0,
    mode: options.mode,
    target: options.target,
    host: target.host,
    fixes: { file: options.fixes, sha256: fileSha256, skipped },
    articles: articles.map(({ slug, rows, plan }) => ({
      slug,
      liveRevisionId: rows.article.current_revision_id,
      version: rows.revision?.version,
      toChange: plan.changes
        .filter((c) => c.state === 'change')
        .map((c) => `${c.locale}:${c.field}`),
      alreadyApplied: plan.changes
        .filter((c) => c.state === 'applied')
        .map((c) => `${c.locale}:${c.field}`),
      draft: plan.inspection,
      ...(plan.errors.length ? { errors: plan.errors } : {}),
      ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
      ...(plan.blockers.length ? { blockers: plan.blockers } : {}),
    })),
    ...(errors.length ? { errors } : {}),
    blockers,
    applyReady: errors.length === 0 && blockers.length === 0 && pending.length > 0,
  };
  if (!target.local && options.mode === 'plan') report.applyWith = `--confirm-hash=${fileSha256}`;
  if (options.mode === 'plan' || !report.ok || pending.length === 0) return report;
  if (blockers.length) throw new ContentFixError('DRAFT_BLOCKED', blockers);
  const { repo, actorId } = await operatorRepository({
    ...target,
    operatorEmail: options.operatorEmail,
    receipt: fileSha256,
  });
  const receipt = { fixesSha256: fileSha256, reviewedAt: new Date().toISOString() };
  report.published = {};
  for (const { slug, rows, plan } of pending)
    report.published[slug] = await applyArticle({
      service: target.service,
      repo,
      actorId,
      slug,
      rows,
      plan,
      receipt,
    });
  return report;
}

await runCli(import.meta.url, run);
