import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  coerceContentMetadata,
  publishableContentMetadataSchema,
} from '../../lib/content/content-metadata.ts';
import { isSafeArticleSourceUrl } from '../../lib/validation/article.ts';
import { isSafeSourceUrl } from '../../lib/validation/source-url.ts';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

const CONTROL_CHARACTER = String.fromCharCode(1);
const BACKSLASH = String.fromCharCode(92);

test('one predicate decides what a source link is', () => {
  assert.equal(isSafeSourceUrl('https://adilet.zan.kz/rus/docs/K1500000414'), true);
  assert.equal(isSafeSourceUrl('https://enbek.gov.kz:8443/ru/node/1'), true);

  // The metadata check used to be `/^https:[/][/][^s]+$/`, which accepts all of
  // these. Every one of them renders as an <a href> on a public page.
  assert.equal(isSafeSourceUrl('https://operator:secret@evil.example/doc'), false);
  assert.equal(isSafeSourceUrl(`https://host/${CONTROL_CHARACTER}`), false);
  assert.equal(isSafeSourceUrl(`https:/${BACKSLASH}evil.example`), false);
  assert.equal(isSafeSourceUrl('http://adilet.zan.kz/x'), false);
  assert.equal(isSafeSourceUrl('javascript:alert(1)'), false);
  assert.equal(isSafeSourceUrl(''), false);
  assert.equal(isSafeSourceUrl(`https://host/${'a'.repeat(2_100)}`), false);
});

test('an article block is stricter than a bibliography entry', () => {
  // A WhatsApp link must resolve from the current global contacts rather than
  // being frozen into the document, and running prose links carry no port.
  assert.equal(isSafeArticleSourceUrl('https://wa.me/77001234567'), false);
  assert.equal(isSafeArticleSourceUrl('https://enbek.gov.kz:8443/ru/node/1'), false);
  assert.equal(isSafeArticleSourceUrl('https://host/%2e%2e/etc'), false);
  assert.equal(isSafeArticleSourceUrl('https://adilet.zan.kz/rus/docs/K1500000414'), true);
});

test('one bad reference no longer erases the whole metadata block', () => {
  const metadata = coerceContentMetadata({
    jurisdiction: 'Республика Казахстан',
    effectiveDate: '2026-01-01',
    sources: [
      { title: 'Трудовой кодекс', url: 'https://adilet.zan.kz/rus/docs/K1500000414' },
      { title: 'Опечатка', url: 'htps://adilet.zan.kz/x' },
      { title: 'Правила', url: 'https://adilet.zan.kz/rus/docs/V2100000000' },
    ],
  });

  // Previously a single malformed URL made the parse fail and the reader saw no
  // jurisdiction, no effective date and no references at all.
  assert.equal(metadata.jurisdiction, 'Республика Казахстан');
  assert.equal(metadata.effectiveDate, '2026-01-01');
  assert.deepEqual(
    metadata.sources.map((source) => source.title),
    ['Трудовой кодекс', 'Правила'],
  );
});

test('publication refuses a reference the reader would never see', () => {
  const draft = {
    jurisdiction: '',
    effectiveDate: '',
    sources: [{ title: 'Черновик', url: 'https://ad' }],
  };
  assert.equal(publishableContentMetadataSchema.safeParse(draft).success, true);

  const broken = {
    jurisdiction: '',
    effectiveDate: '',
    sources: [{ title: 'Ссылка', url: 'https://operator:secret@evil.example' }],
  };
  const parsed = publishableContentMetadataSchema.safeParse(broken);
  assert.equal(parsed.success, false);
  assert.deepEqual(parsed.error.issues[0].path, ['sources', 0, 'url']);
});

test('both publication paths run the gate', async () => {
  const [admin, articles] = await Promise.all([
    read('lib/validation/admin.ts'),
    read('lib/actions/articles.ts'),
  ]);
  // `...contentMetadataDraftSchema.shape` copies the fields and drops the
  // object-level refinement, so the gate has to be re-applied explicitly.
  assert.match(admin, /publishableContentMetadataSchema\.safeParse/u);
  assert.match(articles, /publishableContentMetadataSchema\.parse/u);
});
