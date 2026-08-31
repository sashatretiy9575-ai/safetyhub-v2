import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();

function argumentValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return path.resolve(root, value);
}

const articlesDirectory = argumentValue(
  '--articles-root',
  path.join(root, 'content', 'articles'),
);
const courseSnapshotsDirectory = argumentValue(
  '--courses-root',
  path.join(root, 'content', 'snapshots', 'courses'),
);
const mediaSnapshotsDirectory = argumentValue(
  '--media-root',
  path.join(root, 'content', 'snapshots', 'media'),
);
const outputPath = argumentValue('--output', path.join(root, 'supabase', 'seed.sql'));
const checkOnly = process.argv.includes('--check');

function defaultSeo(title, description, ogImage = '') {
  const safeTitle = title.trim().slice(0, 70);
  const candidateDescription = description.trim();
  const safeDescription = (
    candidateDescription.length >= 40
      ? candidateDescription
      : `${candidateDescription}. Практический материал SafetyHub по безопасности труда и промышленной безопасности.`
  ).slice(0, 200);
  return {
    title: safeTitle,
    description: safeDescription,
    ogTitle: safeTitle,
    ogDescription: safeDescription,
    ogImage,
    indexable: true,
  };
}

async function readJsonDirectory(directory) {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.json')).sort();
  return Promise.all(
    files.map(async (file) => JSON.parse(await readFile(path.join(directory, file), 'utf8'))),
  );
}

const courseCatalog = JSON.parse(
  await readFile(path.join(courseSnapshotsDirectory, 'catalog.json'), 'utf8'),
);
const rawCourses = await Promise.all(
  courseCatalog.courses.map(async ({ slug }) =>
    JSON.parse(
      await readFile(path.join(courseSnapshotsDirectory, slug, 'course.json'), 'utf8'),
    ),
  ),
);
const rawArticles = await readJsonDirectory(articlesDirectory);
const mediaManifest = JSON.parse(
  await readFile(path.join(mediaSnapshotsDirectory, 'manifest.json'), 'utf8'),
);

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}

function canonicalHash(value) {
  return createHash('sha256').update(JSON.stringify(sortJson(value))).digest('hex');
}

function referencedContentAssetIds(value) {
  return new Set(
    [...JSON.stringify(value).matchAll(
      /\/api\/content-assets\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/giu,
    )].map((match) => match[1].toLowerCase()),
  );
}

const mediaManifestProjection = {
  schemaVersion: mediaManifest.schemaVersion,
  bucket: mediaManifest.bucket,
  assets: mediaManifest.assets,
};
if (
  mediaManifest.schemaVersion !== 1 ||
  mediaManifest.bucket !== 'content-media' ||
  !Array.isArray(mediaManifest.assets) ||
  mediaManifest.manifestHash !== canonicalHash(mediaManifestProjection)
) {
  throw new Error('The public content media manifest is invalid.');
}

if (
  rawCourses.length < 1 ||
  rawCourses.length !== courseCatalog.courses.length ||
  new Set(rawCourses.map((course) => course.slug)).size !== rawCourses.length
) {
  throw new Error('The canonical seed must contain the unique courses listed in catalog.json.');
}
if (
  rawArticles.length < 1 ||
  new Set(rawArticles.map((article) => article.slug)).size !== rawArticles.length
) {
  throw new Error('The article seed must contain at least one unique article.');
}

const forbiddenMetadata = [
  'reviewer',
  'reviewedAt',
  'nextReviewAt',
  'reviewedContentHash',
  'reviewStatus',
];

for (const item of [...rawCourses, ...rawArticles]) {
  for (const key of forbiddenMetadata) {
    if (Object.hasOwn(item, key)) throw new Error(`${item.slug}: obsolete field ${key}.`);
  }
}

const courses = rawCourses.map((course, index) => {
  if (
    course.slug !== courseCatalog.courses[index]?.slug ||
    course.displayOrder !== index + 1
  ) {
    throw new Error(`${course.slug}: canonical display order is invalid.`);
  }
  if (
    !Number.isInteger(course.policy?.durationMinutes) ||
    course.policy.durationMinutes < 1 ||
    course.policy.durationMinutes > 120 ||
    !Number.isInteger(course.policy?.passScore) ||
    course.policy.passScore < 1 ||
    course.policy.passScore > 10 ||
    course.policy?.questionCount !== 10 ||
    course.policy?.variantCount !== 3 ||
    !Number.isInteger(course.policy?.attemptsPerCalendarDay) ||
    course.policy.attemptsPerCalendarDay < 1 ||
    course.policy.attemptsPerCalendarDay > 50 ||
    course.policy?.resetTimezone !== 'Asia/Oral'
  ) {
    throw new Error(`${course.slug}: course policy is outside the supported contract.`);
  }
  if (
    !Array.isArray(course.variants) ||
    course.variants.length !== 3 ||
    course.variants.some(
      (variant) =>
        !Array.isArray(variant.questions) ||
        variant.questions.length !== 10 ||
        variant.questions.some(
          (question) => !Array.isArray(question.options) || question.options.length !== 4,
        ),
    )
  ) {
    throw new Error(`${course.slug}: expected 3 variants × 10 questions × 4 options.`);
  }
  if (course.contentHash !== course.dbContentHash) {
    throw new Error(`${course.slug}: database content hash receipt is inconsistent.`);
  }
  return course;
});

const mediaAssetsById = new Map();
const mediaStorageKeys = new Set();
const mediaHashes = new Set();
for (const asset of mediaManifest.assets) {
  if (
    !asset ||
    typeof asset !== 'object' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(asset.id) ||
    !/^[0-9a-f]{2}\/[0-9a-f]{64}[.]webp$/u.test(asset.storageKey) ||
    !/^[0-9a-f]{64}$/u.test(asset.sha256) ||
    asset.mimeType !== 'image/webp' ||
    asset.file !== `${asset.sha256}.webp` ||
    !Number.isInteger(asset.width) ||
    asset.width < 1 ||
    asset.width > 1600 ||
    !Number.isInteger(asset.height) ||
    asset.height < 1 ||
    asset.height > 1600 ||
    !Number.isInteger(asset.byteSize) ||
    asset.byteSize < 1 ||
    asset.byteSize > 2 * 1024 * 1024 ||
    mediaAssetsById.has(asset.id) ||
    mediaStorageKeys.has(asset.storageKey) ||
    mediaHashes.has(asset.sha256)
  ) {
    throw new Error(`The public content media entry is invalid: ${asset?.id ?? 'unknown'}.`);
  }
  const bytes = await readFile(path.join(mediaSnapshotsDirectory, asset.file));
  if (
    bytes.length !== asset.byteSize ||
    createHash('sha256').update(bytes).digest('hex') !== asset.sha256
  ) {
    throw new Error(`The public content media file is inconsistent: ${asset.id}.`);
  }
  mediaAssetsById.set(asset.id, asset);
  mediaStorageKeys.add(asset.storageKey);
  mediaHashes.add(asset.sha256);
}

const articles = await Promise.all(
  rawArticles.map(async (article) => {
    if (article.coverImage?.startsWith('/images/')) {
      await access(path.join(root, 'public', article.coverImage.slice(1)));
    } else {
      const coverAssetIds = referencedContentAssetIds(article.coverImage ?? '');
      if (coverAssetIds.size !== 1 || !mediaAssetsById.has([...coverAssetIds][0])) {
        throw new Error(`${article.slug}: article cover asset is unavailable.`);
      }
    }
    const normalizedArticle = {
      slug: article.slug,
      title: article.title,
      description: article.description,
      coverImage: article.coverImage,
      blocks: article.blocks,
      seo:
        article.seo && typeof article.seo === 'object' && !Array.isArray(article.seo)
          ? article.seo
          : defaultSeo(article.title, article.description, article.coverImage),
      jurisdiction: article.jurisdiction || '',
      effectiveDate: article.effectiveDate || '',
      sources: Array.isArray(article.sources) ? article.sources : [],
      createdAt: article.createdAt,
      updatedAt: article.updatedAt,
    };
    for (const assetId of referencedContentAssetIds(normalizedArticle)) {
      if (!mediaAssetsById.has(assetId)) {
        throw new Error(`${article.slug}: referenced media asset ${assetId} is unavailable.`);
      }
    }
    return normalizedArticle;
  }),
);

const coursesPayload = JSON.stringify(courses);
const articlesPayload = JSON.stringify(articles);
const mediaAssetsPayload = JSON.stringify(mediaManifest.assets);

const sql = `-- Canonical, idempotent development seed generated from content snapshots.
-- Run npm run content:seed:generate after changing bundled courses or articles.

do $seed$
declare
  v_asset jsonb;
begin
  for v_asset in
    select value from jsonb_array_elements($media$${mediaAssetsPayload}$media$::jsonb)
  loop
    insert into public.content_assets (
      id, storage_key, mime_type, width, height, byte_size, sha256,
      original_filename, status, created_at
    ) values (
      (v_asset ->> 'id')::uuid,
      v_asset ->> 'storageKey',
      v_asset ->> 'mimeType',
      (v_asset ->> 'width')::integer,
      (v_asset ->> 'height')::integer,
      (v_asset ->> 'byteSize')::integer,
      v_asset ->> 'sha256',
      'published-' || left(v_asset ->> 'sha256', 16) || '.webp',
      'active',
      timestamptz '2026-08-25T00:00:00Z'
    )
    on conflict (id) do nothing;

    if not exists (
      select 1 from public.content_assets asset
      where asset.id = (v_asset ->> 'id')::uuid
        and asset.storage_key = v_asset ->> 'storageKey'
        and asset.mime_type = v_asset ->> 'mimeType'
        and asset.width = (v_asset ->> 'width')::integer
        and asset.height = (v_asset ->> 'height')::integer
        and asset.byte_size = (v_asset ->> 'byteSize')::integer
        and asset.sha256 = v_asset ->> 'sha256'
        and asset.status = 'active'
    ) then
      raise exception 'CONTENT_MEDIA_SNAPSHOT_CONFLICT:%', v_asset ->> 'id';
    end if;
  end loop;
end;
$seed$;

do $seed$
declare
  v_course jsonb;
  v_test_id uuid;
  v_presentation_id uuid;
  v_hash text;
begin
  for v_course in
    select value from jsonb_array_elements($courses$${coursesPayload}$courses$::jsonb)
  loop
    v_test_id := (v_course ->> 'id')::uuid;
    v_presentation_id := (v_course -> 'presentation' ->> 'id')::uuid;
    v_hash := private.course_content_hash_v3(
      v_course ->> 'slug', v_course ->> 'title', v_course ->> 'description',
      v_course ->> 'icon', (v_course ->> 'displayOrder')::integer,
      v_course -> 'presentation' ->> 'sha256',
      (v_course -> 'presentation' ->> 'pageCount')::integer,
      (v_course -> 'policy' ->> 'durationMinutes')::integer,
      (v_course -> 'policy' ->> 'passScore')::integer,
      (v_course -> 'policy' ->> 'attemptsPerCalendarDay')::integer,
      v_course -> 'policy' ->> 'resetTimezone', v_course -> 'variants',
      coalesce(v_course -> 'seo', '{}'::jsonb),
      nullif(v_course ->> 'jurisdiction', ''),
      nullif(v_course ->> 'effectiveDate', '')::date,
      coalesce(v_course -> 'sources', '[]'::jsonb)
    );
    if v_hash is distinct from v_course ->> 'dbContentHash' then
      raise exception 'COURSE_SNAPSHOT_HASH_MISMATCH:%', v_course ->> 'slug';
    end if;

    insert into public.tests as existing_test (
      id, slug, title, description, icon, display_order, seo, draft_content,
      duration_minutes, pass_score, attempts_per_calendar_day,
      attempt_reset_timezone, status, jurisdiction, effective_date, sources, content_hash,
      created_at, updated_at
    ) values (
      v_test_id, v_course ->> 'slug', v_course ->> 'title',
      v_course ->> 'description', v_course ->> 'icon',
      (v_course ->> 'displayOrder')::integer, coalesce(v_course -> 'seo', '{}'::jsonb),
      jsonb_build_object('questions', '[]'::jsonb, 'questionVariants', v_course -> 'variants'),
      (v_course -> 'policy' ->> 'durationMinutes')::integer,
      (v_course -> 'policy' ->> 'passScore')::integer,
      (v_course -> 'policy' ->> 'attemptsPerCalendarDay')::integer,
      v_course -> 'policy' ->> 'resetTimezone', 'draft',
      nullif(v_course ->> 'jurisdiction', ''),
      nullif(v_course ->> 'effectiveDate', '')::date,
      coalesce(v_course -> 'sources', '[]'::jsonb), v_hash,
      (v_course ->> 'updatedAt')::timestamptz,
      (v_course ->> 'updatedAt')::timestamptz
    )
    on conflict (slug) do update set updated_at = existing_test.updated_at
    returning id into v_test_id;

    if v_test_id is distinct from (v_course ->> 'id')::uuid then
      raise exception 'COURSE_SNAPSHOT_ID_CONFLICT:%', v_course ->> 'slug';
    end if;

    insert into public.course_presentations (
      id, course_id, storage_bucket, storage_path, thumbnail_path,
      source_filename, mime_type, byte_size, sha256, page_count, aspect_ratio,
      status, created_at, validated_at
    ) values (
      v_presentation_id, v_test_id,
      v_course -> 'presentation' ->> 'storageBucket',
      v_course -> 'presentation' ->> 'storagePath',
      v_course -> 'presentation' ->> 'thumbnailPath',
      v_course -> 'presentation' ->> 'sourceFilename',
      v_course -> 'presentation' ->> 'mimeType',
      (v_course -> 'presentation' ->> 'byteSize')::bigint,
      v_course -> 'presentation' ->> 'sha256',
      (v_course -> 'presentation' ->> 'pageCount')::integer,
      v_course -> 'presentation' ->> 'aspectRatio', 'ready',
      (v_course ->> 'updatedAt')::timestamptz,
      (v_course ->> 'updatedAt')::timestamptz
    ) on conflict (id) do nothing;

    insert into public.course_drafts (
      test_id, slug, title, description, icon, display_order, presentation_id,
      duration_minutes, pass_score, attempts_per_calendar_day,
      attempt_reset_timezone, content, questions, question_variants, seo,
      jurisdiction, effective_date, sources,
      content_hash, created_at, updated_at
    ) values (
      v_test_id, v_course ->> 'slug', v_course ->> 'title',
      v_course ->> 'description', v_course ->> 'icon',
      (v_course ->> 'displayOrder')::integer, v_presentation_id,
      (v_course -> 'policy' ->> 'durationMinutes')::integer,
      (v_course -> 'policy' ->> 'passScore')::integer,
      (v_course -> 'policy' ->> 'attemptsPerCalendarDay')::integer,
      v_course -> 'policy' ->> 'resetTimezone',
      '{"modules":[]}'::jsonb, '[]'::jsonb, v_course -> 'variants',
      coalesce(v_course -> 'seo', '{}'::jsonb),
      nullif(v_course ->> 'jurisdiction', ''),
      nullif(v_course ->> 'effectiveDate', '')::date,
      coalesce(v_course -> 'sources', '[]'::jsonb), v_hash,
      (v_course ->> 'updatedAt')::timestamptz,
      (v_course ->> 'updatedAt')::timestamptz
    )
    on conflict (test_id) do update
    set slug = excluded.slug,
        title = excluded.title,
        description = excluded.description,
        icon = excluded.icon,
        display_order = excluded.display_order,
        presentation_id = excluded.presentation_id,
        duration_minutes = excluded.duration_minutes,
        pass_score = excluded.pass_score,
        attempts_per_calendar_day = excluded.attempts_per_calendar_day,
        attempt_reset_timezone = excluded.attempt_reset_timezone,
        content = excluded.content,
        questions = excluded.questions,
        question_variants = excluded.question_variants,
        seo = excluded.seo,
        jurisdiction = excluded.jurisdiction,
        effective_date = excluded.effective_date,
        sources = excluded.sources,
        content_hash = excluded.content_hash,
        draft_version = course_drafts.draft_version + 1,
        updated_at = excluded.updated_at
    where (course_drafts.slug, course_drafts.title, course_drafts.description,
      course_drafts.icon, course_drafts.display_order, course_drafts.presentation_id,
      course_drafts.duration_minutes, course_drafts.pass_score,
      course_drafts.attempts_per_calendar_day, course_drafts.attempt_reset_timezone,
      course_drafts.content, course_drafts.questions, course_drafts.question_variants,
      course_drafts.seo,
      course_drafts.jurisdiction, course_drafts.effective_date,
      course_drafts.sources, course_drafts.content_hash)
      is distinct from
      (excluded.slug, excluded.title, excluded.description, excluded.icon,
      excluded.display_order, excluded.presentation_id, excluded.duration_minutes,
      excluded.pass_score, excluded.attempts_per_calendar_day,
      excluded.attempt_reset_timezone, excluded.content, excluded.questions,
      excluded.question_variants, excluded.seo, excluded.jurisdiction,
      excluded.effective_date, excluded.sources, excluded.content_hash);

    if not exists (
      select 1
      from public.tests test
      join public.test_revisions revision on revision.id = test.current_revision_id
      where test.id = v_test_id
        and revision.content_hash = v_hash
        and revision.presentation_id = v_presentation_id
        and revision.jurisdiction is not distinct from nullif(v_course ->> 'jurisdiction', '')
        and revision.effective_date is not distinct from nullif(v_course ->> 'effectiveDate', '')::date
        and revision.sources = coalesce(v_course -> 'sources', '[]'::jsonb)
    ) then
      perform private.publish_course_revision_v3_unmetered(null, v_test_id, v_hash);
    else
      update public.tests set status = 'published' where id = v_test_id;
    end if;
  end loop;
end;
$seed$;

do $seed$
declare
  v_article jsonb;
  v_article_id uuid;
  v_revision_id uuid;
  v_hash text;
  v_version integer;
begin
  for v_article in
    select value from jsonb_array_elements($articles$${articlesPayload}$articles$::jsonb)
  loop
    v_hash := private.article_content_hash_v2(
      v_article ->> 'slug', v_article ->> 'title',
      v_article ->> 'description', v_article ->> 'coverImage',
      v_article -> 'blocks', v_article -> 'seo',
      nullif(v_article ->> 'jurisdiction', ''),
      nullif(v_article ->> 'effectiveDate', '')::date,
      v_article -> 'sources'
    );

    insert into public.articles as existing_article (
      slug, title, description, cover_image, blocks, seo, status,
      is_published, jurisdiction, effective_date, sources, content_hash,
      created_at, updated_at
    ) values (
      v_article ->> 'slug', v_article ->> 'title',
      v_article ->> 'description', v_article ->> 'coverImage',
      '[]'::jsonb, v_article -> 'seo', 'draft', false,
      nullif(v_article ->> 'jurisdiction', ''),
      nullif(v_article ->> 'effectiveDate', '')::date,
      v_article -> 'sources', v_hash,
      (v_article ->> 'createdAt')::timestamptz,
      (v_article ->> 'updatedAt')::timestamptz
    )
    on conflict (slug) do update set updated_at = existing_article.updated_at
    returning id into v_article_id;

    insert into public.article_drafts (
      article_id, slug, title, description, cover_image, blocks, seo,
      jurisdiction, effective_date, sources, content_hash, created_at, updated_at
    ) values (
      v_article_id, v_article ->> 'slug', v_article ->> 'title',
      v_article ->> 'description', v_article ->> 'coverImage',
      v_article -> 'blocks', v_article -> 'seo',
      nullif(v_article ->> 'jurisdiction', ''),
      nullif(v_article ->> 'effectiveDate', '')::date,
      v_article -> 'sources', v_hash,
      (v_article ->> 'createdAt')::timestamptz,
      (v_article ->> 'updatedAt')::timestamptz
    )
    on conflict (article_id) do update
    set slug = excluded.slug,
        title = excluded.title,
        description = excluded.description,
        cover_image = excluded.cover_image,
        blocks = excluded.blocks,
        seo = excluded.seo,
        jurisdiction = excluded.jurisdiction,
        effective_date = excluded.effective_date,
        sources = excluded.sources,
        content_hash = excluded.content_hash,
        draft_version = article_drafts.draft_version + 1,
        updated_at = excluded.updated_at
    where (article_drafts.slug, article_drafts.title, article_drafts.description,
      article_drafts.cover_image, article_drafts.blocks, article_drafts.seo,
      article_drafts.jurisdiction, article_drafts.effective_date,
      article_drafts.sources, article_drafts.content_hash)
      is distinct from
      (excluded.slug, excluded.title, excluded.description, excluded.cover_image,
      excluded.blocks, excluded.seo, excluded.jurisdiction,
      excluded.effective_date, excluded.sources, excluded.content_hash);

    perform private.sync_content_asset_usages(
      'article_draft', v_article_id, 0,
      jsonb_build_object(
        'coverImage', v_article ->> 'coverImage',
        'blocks', v_article -> 'blocks',
        'seo', v_article -> 'seo'
      )
    );

    if not exists (
      select 1
      from public.articles article
      join public.article_revisions revision on revision.id = article.current_revision_id
      where article.id = v_article_id
        and revision.content_hash = v_hash
        and revision.jurisdiction is not distinct from nullif(v_article ->> 'jurisdiction', '')
        and revision.effective_date is not distinct from nullif(v_article ->> 'effectiveDate', '')::date
        and revision.sources = v_article -> 'sources'
    ) then
      select content_version + 1 into v_version
      from public.articles where id = v_article_id for update;
      insert into public.article_revisions (
        article_id, version, slug, title, description, cover_image, blocks, seo,
        jurisdiction, effective_date, sources, content_hash, published_at
      ) values (
        v_article_id, v_version, v_article ->> 'slug', v_article ->> 'title',
        v_article ->> 'description', v_article ->> 'coverImage',
        v_article -> 'blocks', v_article -> 'seo',
        nullif(v_article ->> 'jurisdiction', ''),
        nullif(v_article ->> 'effectiveDate', '')::date,
        v_article -> 'sources', v_hash,
        (v_article ->> 'updatedAt')::timestamptz
      ) returning id into v_revision_id;
      perform private.sync_content_asset_usages(
        'article_revision', v_article_id, v_version,
        jsonb_build_object(
          'coverImage', v_article ->> 'coverImage',
          'blocks', v_article -> 'blocks',
          'seo', v_article -> 'seo'
        )
      );
      update public.articles
      set title = v_article ->> 'title',
          description = v_article ->> 'description',
          cover_image = v_article ->> 'coverImage',
          blocks = v_article -> 'blocks',
          seo = v_article -> 'seo',
          status = 'published',
          is_published = true,
          published_at = coalesce(published_at, (v_article ->> 'createdAt')::timestamptz),
          current_revision_id = v_revision_id,
          content_version = v_version,
          jurisdiction = nullif(v_article ->> 'jurisdiction', ''),
          effective_date = nullif(v_article ->> 'effectiveDate', '')::date,
          sources = v_article -> 'sources',
          content_hash = v_hash,
          updated_at = (v_article ->> 'updatedAt')::timestamptz
      where id = v_article_id;
    else
      update public.articles
      set status = 'published', is_published = true
      where id = v_article_id;
    end if;
  end loop;
end;
$seed$;

insert into public.legal_document_versions (
  document_type, version, body_revision, is_current, effective_at
) values
  ('privacy', '1.1', 'privacy-1.1', true, timestamptz '2026-08-13T00:00:00Z'),
  ('terms', '2.1', 'terms-2.1', true, timestamptz '2026-08-13T00:00:00Z')
on conflict (document_type, version) do nothing;

insert into public.site_settings (
  singleton, phone_e164, phone_display, whatsapp_e164,
  whatsapp_same_as_phone, version
) values (
  true, '+77017290349', '+7 701 729 0349', '+77017290349', true, 1
)
on conflict (singleton) do nothing;
`;

if (checkOnly) {
  let existing = '';
  try {
    existing = await readFile(outputPath, 'utf8');
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error;
  }
  if (existing !== sql) {
    console.error('supabase/seed.sql is stale; run npm run content:seed:generate.');
    process.exitCode = 1;
  }
} else {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, sql, 'utf8');
}
