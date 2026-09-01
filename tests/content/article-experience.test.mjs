import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  articleBlocksSchema,
  articleDraftInputSchema,
  isSafeArticleSourceUrl,
} from '../../lib/validation/article.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => readFile(path.join(root, file), 'utf8');

const article = {
  slug: 'article-without-cover',
  title: 'Статья без обложки',
  description: '',
  coverImage: '',
  blocks: [{ type: 'paragraph', content: 'Проверенный текст.' }],
};

test('drafts and published article payloads can intentionally omit a cover', () => {
  const parsed = articleDraftInputSchema.safeParse(article);
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.coverImage, '');
  assert.equal(articleDraftInputSchema.safeParse({ ...article, coverImage: null }).success, true);
  const legacyPlaceholder = articleDraftInputSchema.parse({
    ...article,
    coverImage: '/images/blog/placeholder.jpg',
  });
  assert.equal(legacyPlaceholder.coverImage, '');
});

test('semantic article blocks validate and tables preserve a rectangular shape', () => {
  const blocks = [
    { type: 'heading', level: 2, content: 'Раздел' },
    { type: 'list', style: 'ordered', items: ['Первый', 'Второй'] },
    {
      type: 'table',
      caption: 'Сроки',
      headers: ['Средство', 'Срок'],
      rows: [['Каска', '24 месяца']],
    },
    { type: 'callout', tone: 'warning', title: 'Важно', content: 'Проверьте редакцию.' },
    {
      type: 'source',
      title: 'Нормативный документ',
      url: 'https://adilet.zan.kz/rus/docs/example',
      note: 'Действующая редакция',
    },
  ];
  assert.equal(articleBlocksSchema.safeParse(blocks).success, true);
  assert.equal(
    articleBlocksSchema.safeParse([
      { type: 'table', headers: ['Один', 'Два'], rows: [['Только один']] },
    ]).success,
    false,
  );
  assert.equal(
    articleBlocksSchema.safeParse([{ type: 'heading', level: 1, content: 'Недопустимый H1' }])
      .success,
    false,
  );
  assert.equal(isSafeArticleSourceUrl('https://adilet.zan.kz/rus/docs/example'), true);
  assert.equal(isSafeArticleSourceUrl('https://wa.me/77000000000'), false);
  assert.equal(isSafeArticleSourceUrl('http://example.com/source'), false);
  assert.equal(isSafeArticleSourceUrl('javascript:alert(1)'), false);
});

test('every content image has an explicit decorative or meaningful alternative state', () => {
  assert.equal(
    articleBlocksSchema.safeParse([
      {
        type: 'image',
        src: '/images/generated/photo.webp',
        alt: 'Работник проверяет каску',
        decorative: false,
      },
      {
        type: 'slider',
        label: 'Примеры СИЗ',
        images: [
          { src: '/images/generated/one.webp', alt: '', decorative: true },
          {
            src: '/images/generated/two.webp',
            alt: 'Защитные очки с боковыми экранами',
            decorative: false,
          },
        ],
      },
    ]).success,
    true,
  );
  for (const image of [
    { type: 'image', src: '/images/generated/photo.webp', alt: '', decorative: false },
    {
      type: 'image',
      src: '/images/generated/photo.webp',
      alt: 'Не должно объявляться',
      decorative: true,
    },
  ]) {
    assert.equal(articleBlocksSchema.safeParse([image]).success, false);
  }

  const legacy = articleBlocksSchema.parse([
    {
      type: 'slider',
      images: ['/images/generated/one.webp', '/images/generated/two.webp'],
    },
  ]);
  assert.equal(legacy[0].type, 'slider');
  if (legacy[0].type === 'slider') {
    assert.deepEqual(
      legacy[0].images.map(({ alt, decorative }) => ({ alt, decorative })),
      [
        { alt: '', decorative: true },
        { alt: '', decorative: true },
      ],
    );
  }
});

test('public article composition is wide, single-column, readable, and related', async () => {
  const [page, renderer] = await Promise.all([
    read('app/(public)/blog/[slug]/page.tsx'),
    read('components/article-renderer/index.tsx'),
  ]);
  assert.match(page, /getArticleBySlug\(slug, locale\)/);
  assert.match(page, /getArticles\(locale\)/);
  assert.match(page, /getSiteContacts\(\)/);
  assert.match(page, /<Container size="wide">/);
  assert.match(page, /article\.coverImage \? \(/);
  assert.doesNotMatch(page, /<Container size="narrow">/);
  assert.match(page, /getArticleToc\(article\.blocks\)/);
  assert.match(page, /max-w-\[70rem\]/);
  assert.doesNotMatch(page, /max-w-\[46rem\]/);
  assert.match(page, /toc\.length >= 4 && readTime >= 2/);
  assert.match(page, /data-article-region="toc"[\s\S]+max-w-\[70rem\]/);
  assert.match(page, /data-article-region="body"[\s\S]+max-w-\[70rem\]/);
  assert.doesNotMatch(page, /sticky top-24/);
  assert.doesNotMatch(page, /aria-label="О материале"/);
  assert.doesNotMatch(page, /modifiedTime: article\.reviewedAt/);
  assert.doesNotMatch(page, /dateModified: article\.reviewedAt/);
  assert.match(page, /<ArticleSources[\s\S]+label=\{t\('sources'/);
  assert.match(page, /t\('sources', \{ count: article\.sources\?\.length \?\? 0 \}\)/);
  assert.match(page, /<RelatedArticles[\s\S]+articles=\{relatedArticles\}[\s\S]+locale=\{locale\}/);
  assert.match(renderer, /data-article-cta/);
  assert.match(renderer, /ARTICLE_WHATSAPP_ACTION_URL/);
  assert.match(renderer, /<ContactLink kind="whatsapp" contacts=\{contacts\}/);
  assert.match(page, /<ArticleRenderer blocks=\{article\.blocks\} contacts=\{contacts\} \/>/);
  assert.match(renderer, /\{block\.text\}/);
  assert.match(renderer, /<ArrowRight size=\{18\}/);
  assert.match(renderer, /!text-white no-underline/);
});

test('article cards keep copy visible and expose a clear reading action', async () => {
  const [card, blog, resources] = await Promise.all([
    read('components/marketing/article-card.tsx'),
    read('app/(public)/blog/page.tsx'),
    read('components/marketing/resources.tsx'),
  ]);

  assert.doesNotMatch(card, /line-clamp/);
  assert.doesNotMatch(card, /(?:^|\s)h-\[[^\]]+\]/);
  assert.match(card, /t\('read'\)/);
  assert.match(card, /bg-\[var\(--color-primary-soft\)\]/);
  assert.match(blog, /featured=\{index === 0\}/);
  assert.match(resources, /t\('all'\)/);
});

test('stored content and admin editing use the same runtime block contract', async () => {
  const [content, editPage, editor, actions, blockEditor, renderer, carousel, migration] =
    await Promise.all([
      read('lib/content/articles.ts'),
      read('app/(admin)/admin/articles/[slug]/edit/page.tsx'),
      read('components/admin/admin-editor.tsx'),
      read('lib/actions/articles.ts'),
      read('components/admin/content-block-editor.tsx'),
      read('components/article-renderer/index.tsx'),
      read('components/ui/carousel.tsx'),
      read('supabase/migrations/20260813000000_safetyhub_baseline.sql'),
    ]);
  assert.match(content, /articleDocumentMetadataSchema\.safeParse/);
  assert.match(content, /articleDocumentSchema\.parse/);
  assert.match(content, /ARTICLE_BLOCKS_INVALID/);
  assert.doesNotMatch(content, /blocks as unknown as ArticleBlock/);
  assert.match(editPage, /articleBlocksSchema\.safeParse\(data\.blocks\)/);
  assert.match(editor, /<ContentBlockEditor mode="article"/);
  assert.match(editor, /Есть черновик/);
  assert.match(editor, /publishedContentHash === result\.contentHash/);
  assert.match(editPage, /live\.data\.content_hash === data\.content_hash/);
  assert.doesNotMatch(
    actions.slice(
      actions.indexOf('export async function saveArticleAction'),
      actions.indexOf('export async function publishArticleAction'),
    ),
    /revalidateArticlePaths/,
  );
  assert.match(actions, /revalidateArticlePaths\(result\.slug, result\.previousSlug\)/);

  for (const type of ['list', 'table', 'callout', 'source']) {
    assert.match(blockEditor, new RegExp(`'${type}'`));
    assert.match(renderer, new RegExp(`case '${type}'`));
  }
  assert.match(blockEditor, /checked=\{block\.decorative\}/);
  assert.match(blockEditor, /Подпись изображения \$\{imageIndex \+ 1\}/);
  assert.match(blockEditor, /caption: event\.target\.value \|\| undefined/);
  assert.match(blockEditor, /Примечание к источнику/);
  assert.match(blockEditor, /note: event\.target\.value \|\| undefined/);
  assert.match(renderer, /alt=\{block\.decorative \? '' : block\.alt\}/);
  assert.match(renderer, /itemLabel=\{t\('image'\)\}/);
  assert.match(renderer, /getArticleToc\(blocks: unknown\)/);
  assert.match(renderer, /articleBlocksSchema\.safeParse\(blocks\)/);
  assert.match(carousel, /aria-roledescription="carousel"/);
  assert.match(carousel, /onKeyDown=\{handleKeyDown\}/);
  assert.match(carousel, /prefers-reduced-motion: reduce/);
  assert.match(migration, /jsonb_typeof\(p_blocks\) <> 'array'/);
  assert.match(migration, /jsonb_array_length\(p_blocks\) > 100/);
  assert.match(migration, /pg_column_size\(p_blocks\) > 131072/);
  assert.match(migration, /private\.article_content_hash/);
});
