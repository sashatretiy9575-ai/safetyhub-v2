import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { CLIENT_NAMESPACES, PUBLIC_CLIENT_NAMESPACES } from '../../i18n/client-namespaces.ts';

const root = path.resolve(import.meta.dirname, '../..');
const SCAN_ROOTS = ['app', 'components'];

async function collect(directory, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      await collect(absolute, result);
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts'))) {
      result.push(absolute);
    }
  }
  return result;
}

/**
 * Only the namespaces a client component asks for are serialised into the
 * document. A namespace that is missing at runtime is a thrown error, not a
 * silent fallback, so this recomputes the list from the source rather than
 * trusting it.
 */
test('every namespace a client component reads is serialised into the document', async () => {
  const files = (
    await Promise.all(SCAN_ROOTS.map((directory) => collect(path.join(root, directory))))
  ).flat();

  const required = new Set();
  await Promise.all(
    files.map(async (file) => {
      const source = await readFile(file, 'utf8');
      if (!/^'use client';/mu.test(source)) return;
      for (const [, namespace] of source.matchAll(/useTranslations\('([A-Za-z0-9_]+)/gu)) {
        required.add(namespace);
      }
    }),
  );

  const declared = new Set(CLIENT_NAMESPACES);
  assert.deepEqual(
    [...required].filter((namespace) => !declared.has(namespace)).sort(),
    [],
    'a client component reads a namespace that is not sent to the browser',
  );

  // And nothing is carried for the sake of it: the catalog is about 34 KB of
  // JSON per request, and seven namespaces are read only on the server.
  const catalog = JSON.parse(await readFile(path.join(root, 'messages/ru.json'), 'utf8'));
  const serverOnly = Object.keys(catalog).filter((namespace) => !declared.has(namespace));
  assert.ok(serverOnly.length > 0, 'the whole catalog is being sent to the browser again');

  for (const layout of ['app/(account)/layout.tsx', 'app/(admin)/layout.tsx']) {
    const source = await readFile(path.join(root, layout), 'utf8');
    assert.match(source, /messages=\{pickClientNamespaces\(messages\)\}/u, layout);
  }
  for (const layout of ['app/(public)/layout.tsx', 'app/[locale]/layout.tsx']) {
    const source = await readFile(path.join(root, layout), 'utf8');
    assert.match(
      source,
      /messages=\{pickClientNamespaces\(messages, PUBLIC_CLIENT_NAMESPACES\)\}/u,
      layout,
    );
  }
});

test('the public site sends only the namespaces its own client components read', async () => {
  const publicRoots = [
    'app/(public)',
    'app/[locale]',
    'components/marketing',
    'components/layout',
    'components/shared',
    'components/topics',
    'components/ui',
    'components/article-renderer',
  ];
  const files = (
    await Promise.all(publicRoots.map((directory) => collect(path.join(root, directory))))
  ).flat();
  const declared = new Set(PUBLIC_CLIENT_NAMESPACES);
  const missing = new Set();
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (!/^'use client';/mu.test(source)) continue;
    for (const [, namespace] of source.matchAll(/useTranslations\('([A-Za-z0-9_]+)/gu)) {
      if (!declared.has(namespace)) missing.add(`${path.relative(root, file)}: ${namespace}`);
    }
  }
  assert.deepEqual([...missing], []);
});
