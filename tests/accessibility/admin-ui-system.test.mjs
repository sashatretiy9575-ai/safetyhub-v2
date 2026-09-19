import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');

async function sourceFiles(directory) {
  const entries = await readdir(path.join(repositoryRoot, directory), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return sourceFiles(relative);
      return /\.(?:ts|tsx)$/u.test(entry.name) ? [relative] : [];
    }),
  );
  return nested.flat();
}

test('a focused control shows one focus state, not an outline per layer', async () => {
  const css = await read('app/globals.css');
  // The admin shell repainted every control's outline in another colour and at
  // another offset, on top of the control's own; the base rule reshaped corners.
  assert.doesNotMatch(css, /\[data-admin-shell\]\s*:is\([^)]*\):focus-visible/u);
  const baseRule = css.match(/\n\s*:focus-visible\s*\{([^}]*)\}/u)?.[1] ?? '';
  assert.match(baseRule, /outline:\s*3px solid var\(--color-focus\)/u);
  assert.doesNotMatch(baseRule, /border-radius/u);

  for (const file of [...(await sourceFiles('app')), ...(await sourceFiles('components'))]) {
    assert.doesNotMatch(
      await read(file),
      /focus(?:-visible)?:ring-/u,
      `${file} draws a second ring around a focused control`,
    );
  }
});

test('every field primitive shares one frame and one focus recipe', async () => {
  const field = await read('components/ui/field.ts');
  assert.match(field, /focus-visible:border-\[var\(--color-primary\)\]/u);
  assert.match(field, /focus-visible:outline-\[var\(--color-primary-ring\)\]/u);
  assert.match(field, /focus-within:border-\[var\(--color-primary\)\]/u);

  for (const file of ['input', 'textarea', 'select']) {
    const source = await read(`components/ui/${file}.tsx`);
    assert.match(source, /fieldBase,\s*fieldFocus,\s*invalid && fieldInvalid/u, file);
  }
  assert.match(await read('components/admin/admin-filter-select.tsx'), /<Select \{\.\.\.props\}/u);
  assert.match(await read('components/profile/phone-input.tsx'), /<Select\b/u);

  // A bare input inside a worded frame hands its focus state to the frame.
  for (const file of [
    'components/admin/attestations-filter-form.tsx',
    'components/admin/legal-localizations-editor.tsx',
    'components/admin/admin-editor.tsx',
  ]) {
    assert.match(await read(file), /\$\{fieldFrameFocus\}/u, file);
  }
});

test('the confirmation dialog asks for one plain acknowledgement and keeps focus where it is', async () => {
  const dialog = await read('components/admin/destructive-dialog.tsx');
  assert.match(dialog, /DEFAULT_ACKNOWLEDGEMENT = 'Подтверждаю удаление'/u);
  assert.match(dialog, /disabled=\{\(needsAcknowledgement && !confirmed\) \|\| busy\}/u);
  // Re-running the focus effect on every parent render threw focus back to the checkbox.
  assert.match(dialog, /\}, \[open\]\);/u);
  // The overlay portals the panel one render late, so focus moves when the panel
  // attaches (a stable callback ref), not in the effect that runs before it exists.
  assert.match(dialog, /const attachPanel = useCallback\(\(node: HTMLDivElement \| null\) => \{/u);
  assert.match(dialog, /ref=\{attachPanel\}/u);
  assert.doesNotMatch(dialog, /ref=\{panelRef\}/u);
  assert.match(dialog, /className="text-xl font-bold break-words"/u);
});

test('the editor action bar fits a 240 px screen', async () => {
  const bar = await read('components/admin/editor-action-bar.tsx');
  assert.match(bar, /<span className="hidden min-\[280px\]:inline">/u);
  assert.match(bar, /<DropdownMenuItem className="min-\[280px\]:hidden" onSelect=\{onTogglePreview\}>/u);
  assert.match(bar, /hasOverflow \? undefined : 'min-\[280px\]:hidden'/u);
});
