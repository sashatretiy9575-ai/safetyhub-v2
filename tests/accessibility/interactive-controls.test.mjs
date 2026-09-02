import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('small and icon actions keep a 44px target and destructive editor actions confirm', async () => {
  const [button, userMenu, signOutAction, editor, contentEditor] = await Promise.all([
    read('components/ui/button.tsx'),
    read('components/shared/user-menu.tsx'),
    read('components/shared/sign-out-action.tsx'),
    read('components/admin/admin-editor.tsx'),
    read('components/admin/content-block-editor.tsx'),
  ]);

  assert.match(button, /sm: 'h-11/);
  assert.match(button, /icon: 'size-11/);
  assert.match(userMenu, /size="icon"/);
  assert.match(userMenu, /<SignOutAction menuItem \/>/);
  assert.match(signOutAction, /clientRequest\('\/api\/auth\/logout'/);
  assert.doesNotMatch(userMenu, /supabase\/client|auth\.signOut/);
  assert.match(editor, /<ContentBlockEditor mode="article"/);
  assert.match(contentEditor, /window\.confirm\(`Удалить блок/);
  assert.match(contentEditor, /className="text-\[var\(--color-danger\)\]"/);
});

test('hero has one stable heading and no autoplay lifecycle', async () => {
  const hero = await read('components/marketing/hero.tsx');

  assert.match(hero, /<h1[\s\S]*id="hero-heading"/);
  assert.match(hero, /href=\{localizePathname\(ROUTES\.topics, locale\)\}[\s\S]*t\('courses'\)/);
  assert.match(hero, /href=\{localizePathname\(ROUTES\.contacts, locale\)\}[\s\S]*t\('contact'\)/);
  assert.doesNotMatch(hero, /useState|setInterval|aria-live="polite"/);
});

test('testimonials and article galleries keep the original accessible carousel primitive', async () => {
  const carouselPaths = [
    'components/marketing/testimonials.tsx',
    'components/article-renderer/index.tsx',
  ];
  const [carousel, ...consumers] = await Promise.all([
    read('components/ui/carousel.tsx'),
    ...carouselPaths.map(read),
  ]);

  assert.match(carousel, /aria-roledescription="carousel"/);
  assert.match(carousel, /aria-live="polite"/);
  assert.match(carousel, /event\.key === 'ArrowRight'/);
  assert.match(carousel, /event\.key === 'ArrowLeft'/);
  assert.match(carousel, /md:grid/);

  for (const source of consumers) assert.match(source, /<Carousel/);
});

test('marketing collections use the native scroll-snap slider below 1200px', async () => {
  const sliderPaths = [
    'components/marketing/course-grid.tsx',
    'components/marketing/partners-strip.tsx',
    'components/marketing/resources.tsx',
    'components/marketing/process-timeline.tsx',
  ];
  const [slider, carousel, ...consumers] = await Promise.all([
    read('components/ui/marketing-slider.tsx'),
    read('components/ui/carousel.tsx'),
    ...sliderPaths.map(read),
  ]);

  assert.match(slider, /<Carousel/);
  assert.match(slider, /variant="marketing"/);
  assert.match(carousel, /aria-roledescription="carousel"/);
  assert.match(carousel, /aria-live="polite"/);
  assert.match(carousel, /event\.key === 'ArrowRight'/);
  assert.match(carousel, /event\.key === 'ArrowLeft'/);
  assert.match(carousel, /prefers-reduced-motion: reduce/);
  assert.match(carousel, /snap-x snap-mandatory/);
  assert.match(carousel, /min-\[1200px\]:grid-cols-3/);
  assert.match(carousel, /pr-\[14%\]/);
  assert.match(carousel, /data-marketing-carousel-controls/);
  assert.doesNotMatch(carousel, /absolute top-1\/2 (?:left|right)-1/);

  for (const source of consumers) assert.match(source, /<MarketingSlider/);
});

test('complete catalogs expose every item in an ordinary responsive grid', async () => {
  const catalogs = await Promise.all([
    read('app/(public)/topics/page.tsx'),
    read('app/(public)/blog/page.tsx'),
  ]);

  for (const source of catalogs) {
    assert.match(source, /grid items-stretch gap-[45][^"\n]*sm:grid-cols-2/);
    assert.match(source, /min-\[(?:1100|1200)px\]:grid-cols-3/);
    assert.doesNotMatch(source, /<MarketingSlider/);
  }
});
