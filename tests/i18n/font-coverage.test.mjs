import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import test from 'node:test';
import fontkit from '@pdf-lib/fontkit';

const root = new URL('../../', import.meta.url);
const read = (file) => readFile(new URL(file, root), 'utf8');

const styles = await read('app/globals.css');

/**
 * The declared faces, read out of the stylesheet rather than restated here, so
 * this cannot drift away from what the browser is actually told.
 */
function declaredFaces(source) {
  const faces = [];
  for (const [, body] of source.matchAll(/@font-face\s*\{([^}]*)\}/gu)) {
    const family = body.match(/font-family:\s*'([^']+)'/u)?.[1];
    const url = body.match(/src:\s*url\('([^']+)'\)/u)?.[1];
    const range = body.match(/unicode-range:\s*([^;]+);/u)?.[1];
    if (!family || !url) continue;
    faces.push({ family, url, codepoints: range ? parseRange(range) : null });
  }
  return faces;
}

function parseRange(declaration) {
  const spans = [];
  for (const entry of declaration.split(',')) {
    const match = entry.trim().match(/^U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?$/u);
    assert.ok(match, `unparsed unicode-range entry: ${entry.trim()}`);
    const start = Number.parseInt(match[1], 16);
    spans.push([start, match[2] ? Number.parseInt(match[2], 16) : start]);
  }
  return spans;
}

const covers = (spans, codepoint) =>
  spans === null || spans.some(([start, end]) => codepoint >= start && codepoint <= end);

const faces = declaredFaces(styles);
await Promise.all(
  faces.map(async (face) => {
    const bytes = await readFile(new URL(`public${face.url}`, root));
    face.font = fontkit.create(bytes);
  }),
);

/** Which family in the stack ends up drawing a character, or null for none. */
function resolve(stack, codepoint) {
  for (const family of stack) {
    for (const face of faces) {
      if (face.family !== family || !covers(face.codepoints, codepoint)) continue;
      if (face.font.glyphForCodePoint(codepoint).id !== 0) return family;
    }
  }
  return null;
}

// The two stacks declared in app/globals.css, up to the first family this
// project does not ship. Everything past that point is the operating system's.
const LATIN_STACK = ['Manrope', 'SafetyHub Kazakh'];
const CHINESE_STACK = ['SafetyHub Noto Sans SC', 'SafetyHub Kazakh'];

async function charactersIn(patterns) {
  const characters = new Set();
  const visit = (value) => {
    // next-intl rich-text tags such as `<share>…</share>` are markup the
    // renderer consumes, never glyphs a font is asked to draw.
    if (typeof value === 'string')
      for (const character of value.replace(/<\/?[a-z][a-z0-9]*>/gu, '')) characters.add(character);
    else if (Array.isArray(value)) for (const item of value) visit(item);
    else if (value && typeof value === 'object')
      for (const item of Object.values(value)) visit(item);
  };
  for (const pattern of patterns) {
    for await (const file of glob(pattern, { cwd: root })) {
      visit(JSON.parse(await readFile(new URL(file, root), 'utf8')));
    }
  }
  return characters;
}

/**
 * Characters the site uses that no bundled font draws, on purpose. They are
 * symbols rather than letters, so a system fallback is not a typographic
 * defect; the list exists so that a *letter* joining it fails this test.
 */
const SYSTEM_FALLBACK = new Set([
  '​', // zero-width space: no glyph by definition
  '⋮', // the vertical ellipsis on overflow menus
  '✓', // the check mark in the completion badges
  '✚', // the cross in the first-aid marks
  // The language switcher names each language in its own script, so ru, kk and
  // en pages all carry these two. Bundling a Chinese font on every page for one
  // menu entry would cost more than the system fallback it avoids.
  '中',
  '文',
]);

test('every letter the site ships has a glyph in a font the site ships', async () => {
  const characters = await charactersIn([
    'messages/{ru,kk,en}.json',
    'content/localizations/**/{ru,kk,en}.json',
  ]);
  const unresolved = [...characters].filter(
    (character) => resolve(LATIN_STACK, character.codePointAt(0)) === null,
  );
  assert.deepEqual(
    unresolved.filter((character) => !SYSTEM_FALLBACK.has(character)).sort(),
    [],
    'characters with no bundled glyph',
  );
});

test('the Kazakh letters Manrope cannot draw come from the companion family', () => {
  // Manrope has no outline for any of these. Both Cyrillic subsets nevertheless
  // declared ranges covering them, so the browser picked a face that could not
  // draw them and every kk page mixed two typefaces inside single words.
  for (const character of 'ӘәҒғҚқҢңҰұ') {
    const codepoint = character.codePointAt(0);
    assert.equal(
      resolve(LATIN_STACK, codepoint),
      'SafetyHub Kazakh',
      `${character} (U+${codepoint.toString(16).toUpperCase().padStart(4, '0')})`,
    );
    for (const face of faces) {
      if (face.family !== 'Manrope') continue;
      assert.equal(
        covers(face.codepoints, codepoint),
        false,
        `Manrope still claims ${character} in ${face.url}`,
      );
    }
  }
});

test('the Chinese subset covers the content it is asked to render, not just the shell', async () => {
  // html[data-locale='zh'] replaces --font-sans wholesale, so this font draws
  // article bodies as well as buttons. Cut from messages/zh.json alone it knew
  // 150 of the 1015 characters the content uses.
  const characters = await charactersIn(['messages/zh.json', 'content/localizations/**/zh.json']);
  const unresolved = [...characters].filter(
    (character) =>
      !SYSTEM_FALLBACK.has(character) && resolve(CHINESE_STACK, character.codePointAt(0)) === null,
  );
  assert.deepEqual(unresolved.sort(), [], 'Chinese characters with no bundled glyph');
});

test('font files are content-addressed so the immutable cache header is safe', () => {
  for (const face of faces) {
    assert.match(
      face.url,
      /^\/fonts\/[a-z0-9-]+\.[0-9a-f]{8}\.woff2$/u,
      `${face.family} is served from a name that does not follow its bytes: ${face.url}`,
    );
  }
});

test('the immutable cache rule matches every font the stylesheet asks for', async () => {
  const config = await read('next.config.ts');
  const rule = config.match(/source: '\/fonts\/:file\(([^)]+)\)'/u);
  assert.ok(rule, 'next.config.ts has no /fonts cache rule');
  const pattern = new RegExp(`^${rule[1].replaceAll('\\\\', '\\')}$`, 'u');
  for (const face of faces) {
    assert.match(face.url.replace('/fonts/', ''), pattern, `${face.url} would not be cached`);
  }
});
