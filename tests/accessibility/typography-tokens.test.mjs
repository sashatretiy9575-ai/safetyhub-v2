import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(absolute);
      return /\.tsx?$/u.test(entry.name) ? [absolute] : [];
    }),
  );
  return files.flat();
}

// The type scale lives in globals.css as fluid tokens; a component that reaches
// for text-[NNpx] again would bypass the 320 px floor and the 52 px ceiling
// the whole site now shares. Breakpoints are the Tailwind names plus xs and
// wide; the only pixel media queries left are the course card's 280 px badge
// swap and the admin dock's 360 px step (from there its five captions fit one
// row like the site's dock; measured against the shipped Manrope at 11 px), and
// the admin tables keep their 760 px container query plus the 920 px step
// where the narrow sheet widens into the full one.
const ALLOWED_PIXEL_QUERIES = new Set([
  'min-[280px]:',
  'min-[360px]:',
  '@min-[480px]:',
  '@min-[760px]:',
  '@min-[920px]:',
]);

test('components use the fluid type tokens instead of pixel font sizes', async () => {
  const files = [
    ...(await sourceFiles(path.join(root, 'app'))),
    ...(await sourceFiles(path.join(root, 'components'))),
  ];
  const offenders = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/(?<![\w-])text-\[[0-9.]+px\]/gu)) {
      offenders.push(`${path.relative(root, file)}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('layouts use named breakpoints instead of pixel media queries', async () => {
  const files = [
    ...(await sourceFiles(path.join(root, 'app'))),
    ...(await sourceFiles(path.join(root, 'components'))),
  ];
  const offenders = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/@?(?:min|max)-\[[0-9]+px\]:/gu)) {
      if (!ALLOWED_PIXEL_QUERIES.has(match[0])) {
        offenders.push(`${path.relative(root, file)}: ${match[0]}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the theme declares the fluid scale and the two extra breakpoints', async () => {
  const css = await readFile(path.join(root, 'app', 'globals.css'), 'utf8');
  assert.match(css, /--breakpoint-xs: 25rem;/u);
  assert.match(css, /--breakpoint-wide: 75rem;/u);
  for (const token of ['display', 'h1', 'h2', 'h3', 'h4', 'title', 'lead', 'prose']) {
    assert.match(css, new RegExp(`--text-${token}: clamp\\(`, 'u'), token);
    assert.match(css, new RegExp(`--text-${token}--line-height:`, 'u'), token);
  }
  for (const token of ['body-sm', 'caption', 'micro']) {
    assert.match(css, new RegExp(`--text-${token}: [0-9.]+rem;`, 'u'), token);
  }
  // 320 px floor: the display size starts at 26 px and never drops below it.
  assert.match(css, /--text-display: clamp\(1\.625rem,/u);
  // Chinese needs a taller minimum: the CJK face is unreadable at 11 px.
  assert.match(css, /html\[data-locale='zh'\][\s\S]*?--text-micro: 0\.75rem;/u);
});
