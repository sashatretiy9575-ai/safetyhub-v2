import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('blog streams its data grid behind a route-specific skeleton', async () => {
  const [source, articleCard] = await Promise.all([
    read('app/(public)/blog/page.tsx'),
    read('components/marketing/article-card.tsx'),
  ]);

  assert.match(source, /<PageHeader/);
  assert.match(
    source,
    /<Suspense fallback=\{<ArticleGridSkeleton label=\{t\('loading'\)\} \/>\}>/,
  );
  assert.match(source, /async function ArticlesGrid\(\)/);
  // The featured card is the LCP element of this page; the rest stay lazy.
  assert.match(source, /priority=\{index === 0\}/);
  assert.match(articleCard, /placeholder="blur"/);
});

test('hero uses optimized mobile and desktop art direction', async () => {
  const [source, resources] = await Promise.all([
    read('components/marketing/hero.tsx'),
    read('components/marketing/resources.tsx'),
  ]);

  assert.match(source, /import \{ getImageProps \} from 'next\/image'/);
  assert.match(source, /hero-safetyhub-desktop-v2\.webp/);
  assert.match(source, /hero-safetyhub-mobile-v2\.webp/);
  assert.match(source, /<picture>/);
  assert.match(source, /media="\(min-width: 1024px\)"/);
  // No deprecated `priority` and no react-dom preload() hint: a hint from a
  // Server Component rides in every Home-link prefetch, so other pages
  // downloaded the hero. The preload links belong to this page's tree.
  assert.match(source, /loading: 'eager',\s*fetchPriority: 'high'/);
  assert.doesNotMatch(source, /priority: true|from 'react-dom'/);
  assert.match(source, /<link\s+rel="preload"\s+as="image"/);
  assert.match(source, /fetchPriority="high"/);
  assert.doesNotMatch(source, /setInterval|mountedSlides|useState/);
  assert.doesNotMatch(resources, /priority=/);
});
