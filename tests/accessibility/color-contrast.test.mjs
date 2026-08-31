import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');

function channel(value) {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const channels = hex
    .replace('#', '')
    .match(/../g)
    .map((value) => channel(Number.parseInt(value, 16)));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground, background) {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function variables(block) {
  return Object.fromEntries(
    [...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6});/giu)].map((match) => [
      match[1],
      match[2].toLowerCase(),
    ]),
  );
}

function assertPair(palette, foreground, background, minimum) {
  assert.ok(palette[foreground], `missing --${foreground}`);
  assert.ok(palette[background], `missing --${background}`);
  const actual = contrast(palette[foreground], palette[background]);
  assert.ok(
    actual >= minimum,
    `--${foreground} on --${background}: ${actual.toFixed(2)} < ${minimum}`,
  );
}

test('light semantic tokens meet WCAG AA text contrast', async () => {
  const css = await read('app/globals.css');
  const themeBlock = css.match(/@theme\s*\{([\s\S]*?)\n\}/u)?.[1] ?? '';
  const palette = variables(themeBlock);

  for (const [foreground, background] of [
    ['color-text-muted', 'color-bg'],
    ['color-text-subtle', 'color-bg'],
    ['color-primary', 'color-primary-foreground'],
    ['color-primary-hover', 'color-primary-foreground'],
    ['color-on-primary-soft', 'color-primary-soft'],
    ['color-success', 'color-primary-soft'],
    ['color-warning', 'color-accent-amber-soft'],
    ['color-danger', 'color-danger-soft'],
    ['color-danger', 'color-danger-foreground'],
    ['color-accent-sapphire', 'color-accent-sapphire-soft'],
  ]) {
    assertPair(palette, foreground, background, 4.5);
  }
  assertPair(palette, 'color-focus', 'color-bg', 3);
  assertPair(palette, 'color-focus', 'color-surface-muted', 3);
});

test('dark semantic tokens preserve AA contrast', async () => {
  const css = await read('app/globals.css');
  const themeBlock = css.match(/@theme\s*\{([\s\S]*?)\n\}/u)?.[1] ?? '';
  const darkBlock = css.match(/\.dark\s*\{([\s\S]*?)\n  \}/u)?.[1] ?? '';
  const palette = { ...variables(themeBlock), ...variables(darkBlock) };

  for (const [foreground, background] of [
    ['color-text-muted', 'color-bg'],
    ['color-text-subtle', 'color-bg'],
    ['color-primary-foreground', 'color-primary'],
    ['color-on-primary-soft', 'color-primary-soft'],
    ['color-warning', 'color-accent-amber-soft'],
    ['color-danger', 'color-danger-soft'],
    ['color-danger-foreground', 'color-danger'],
    ['color-accent-sapphire', 'color-accent-sapphire-soft'],
  ]) {
    assertPair(palette, foreground, background, 4.5);
  }
  assertPair(palette, 'color-focus', 'color-bg', 3);
  assertPair(palette, 'color-focus', 'color-surface', 3);
});

test('form and action primitives retain an opaque focus outline', async () => {
  const css = await read('app/globals.css');
  assert.match(css, /:focus-visible\s*\{[\s\S]*outline:\s*3px solid var\(--color-focus\)/u);

  for (const file of [
    'components/ui/button.tsx',
    'components/ui/input.tsx',
    'components/ui/textarea.tsx',
    'components/ui/dropdown-menu.tsx',
  ]) {
    assert.doesNotMatch(await read(file), /outline-none/u, `${file} suppresses keyboard focus`);
  }
});
