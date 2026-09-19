import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

const REGISTRY = 'components/admin/document-asset-registry.tsx';
const TILE = 'components/admin/facsimile-tile.tsx';
const LEGACY = 'components/admin/document-image-tiles.tsx';
const PROFILE = 'components/admin/document-profile-fields.tsx';

/** Line breaks and the trailing commas a formatter adds with them say nothing about the code. */
const squeeze = (text) => text.replace(/\s+/gu, '').replace(/,(?=[)\]}])/gu, '');

test('a tile says whose image it is and never shows the record behind it', async () => {
  const registry = await read(REGISTRY);
  // The address of an image is spelled in one module; here it is only asked for.
  assert.doesNotMatch(registry, /registered\?id=|certificate-assets/u);
  assert.match(registry, /registeredDocumentAssetUrl\(entry\.assetId\)/u);
  // An id has three jobs here — the address, the upload's target, React's key —
  // and none of them is text, a tooltip or a screen reader's name.
  const leftovers = squeeze(registry)
    .replace(squeeze('entry.assetId ? registeredDocumentAssetUrl(entry.assetId) : null'), '')
    .replace(squeeze('new URLSearchParams({ owner: entry.ownerId, kind: entry.kind })'), '')
    .replace(squeeze('key={`${entry.kind}:${entry.ownerId}`}'), '');
  assert.doesNotMatch(leftovers, /assetId|ownerId|profileId|\.id\b/u);
  // What is read out or hovered is a name a person gave.
  const worded = [
    ...registry.matchAll(/\s(?:title|alt|aria-label|triggerLabel)=(\{.*?\}(?=[\s>])|"[^"]*")/gu),
  ];
  assert.deepEqual(
    worded.map((match) => match[1]),
    [
      "{entry.usedIn.map((use) => use.label).join(', ') || undefined}",
      '{entry.title}',
      '"Посмотреть"',
      '{entry.title}',
    ],
  );
  assert.match(registry, /<h2 id=\{heading\}[^>]*>\s*\{entry\.title\}\s*<\/h2>/u);
  assert.match(registry, /<p>\{entry\.role\}<\/p>/u);
  assert.match(registry, /role="group"\s+aria-labelledby=\{heading\}/u);
  // «Все программы», or how many of them: the noun follows the total.
  assert.match(registry, /if \(!behind\.length\) return 'Все программы';/u);
  assert.match(registry, /`\$\{usedIn\.length\} из \$\{total\} \$\{noun\}`/u);
  assert.match(registry, /`от \$\{SINCE\.format\(date\)\}`/u);
  assert.match(
    registry,
    /new Intl\.DateTimeFormat\('ru-RU', \{ timeZone: BUSINESS_TIME_ZONE \}\)/u,
  );
});

test('replace and view are the only actions, and every outcome has a short line of its own', async () => {
  const registry = await read(REGISTRY);
  for (const text of [
    'Заменить',
    'Загрузить',
    'Посмотреть',
    'Заменено — для новых выдач',
    'Это изображение уже стоит',
    'Заменено не во всех программах, повторите',
    'Подписант не найден в программах',
    'Не загрузилось, повторите',
  ]) {
    assert.ok(registry.includes(`'${text}'`) || registry.includes(`"${text}"`), text);
  }
  assert.match(registry, /\{picture \? 'Заменить' : 'Загрузить'\}/u);
  assert.match(
    registry,
    /answer\.changed === 0 \? 'Это изображение уже стоит' : 'Заменено — для новых выдач'/u,
  );
  assert.match(registry, /`Повторите через \$\{Math\.ceil\(seconds \/ 60\)\} мин`/u);
  // A bad picture and an oversized one are worded exactly as the legacy tile words them.
  assert.match(
    registry,
    /answer\?\.error === 'CERTIFICATE_IMAGE_INVALID'\) \{\s*return failed\(FACSIMILE_FAILURES\.CERTIFICATE_IMAGE_INVALID\);/u,
  );
  assert.match(
    registry,
    /response\.status === 413\) return failed\(FACSIMILE_FAILURES\.FACSIMILE_TOO_LARGE\);/u,
  );
  assert.match(registry, /facsimileFailure\(error, NOT_UPLOADED\)/u);
  // An image is superseded, never taken away, and never opened as a bare file in a tab.
  assert.doesNotMatch(registry, /Удалить|Убрать|DELETE|confirmDialog|<a\s|target="_blank"/u);
  assert.match(registry, /<AdminDetailDialog title=\{entry\.title\} triggerLabel="Посмотреть">/u);
  assert.match(
    registry,
    /<Button\s+type="button"\s+variant="outline"\s+size="sm"\s+disabled=\{blocked\}/u,
  );
  // The line is there before the answer is, so the answer moves nothing.
  assert.match(registry, /role="status"\s+className=\{cn\(\s*'mt-2 min-h-5 /u);
  assert.match(registry, /"xs:grid-cols-2 grid min-w-0 grid-cols-1 gap-3"/u);
  assert.match(registry, /"mt-auto flex min-w-0 flex-wrap gap-2"/u);
});

test('an upload is one PUT of a prepared PNG, and the form hears of a full and of a partial one', async () => {
  const registry = await read(REGISTRY);
  const code = squeeze(registry);
  assert.ok(
    code.includes(
      squeeze(`clientFetch(
        '/api/admin/documents/assets?' +
          new URLSearchParams({ owner: entry.ownerId, kind: entry.kind }),
        { method: 'PUT', headers: { 'content-type': 'image/png' }, body },
        { timeoutMs: UPLOAD_TIMEOUT_MS },
      )`),
    ),
  );
  assert.match(registry, /const body = await prepareFacsimilePng\(file\);/u);
  // 409 DOCUMENT_ASSET_PARTIAL registered the image and moved most profiles: the form takes both in.
  assert.ok(
    code.includes(
      squeeze(
        'if ((response.ok || response.status === 409) && answer?.asset && Array.isArray(answer.profiles)) {' +
          'const replaced = { asset: answer.asset, profiles: answer.profiles };',
      ),
    ),
  );
  assert.match(registry, /if \(result\.replaced\) onReplaced\(result\.replaced\);/u);
  assert.equal(registry.match(/onReplaced\(result/gu)?.length, 1);
  // Every answer carries all the profiles, so the requests go one after another.
  assert.match(registry, /await inTurn\(\(\) => replaceAsset\(entry, body\)\)/u);
  // The spinner and the lock belong to the tile that uploads, not to the registry.
  const [shell, tile] = registry
    .slice(registry.indexOf('export function DocumentAssetRegistry'))
    .split('function AssetTile');
  assert.doesNotMatch(shell, /useState|busy/u);
  assert.match(tile, /const \[busy, setBusy\] = useState\(false\);/u);
  assert.match(tile, /const blocked = Boolean\(disabled\) \|\| busy;/u);
  assert.match(tile, /\{busy \? <FacsimileSpinner \/> : null\}/u);
  assert.match(tile, /<fieldset disabled=\{blocked \|\| !picture\}/u);
});

test('both kinds of tile are made of the same sheet, source and words', async () => {
  const [tile, legacy, registry] = await Promise.all([read(TILE), read(LEGACY), read(REGISTRY)]);
  // Ink is judged on paper: white in the dark theme too, and always the same shape.
  assert.match(tile, /aspect-\[4\/3\][^']* bg-white /u);
  assert.match(tile, /export const FACSIMILE_FAILURES = \{/u);
  assert.match(tile, /accept: FACSIMILE_INPUT_TYPES/u);
  assert.match(tile, /eslint-disable-next-line @next\/next\/no-img-element/u);
  for (const source of [legacy, registry]) {
    assert.match(source, /from '@\/components\/admin\/facsimile-tile';/u);
    assert.match(source, /<input \{\.\.\.source\.input\} \/>/u);
    assert.match(source, /\{\.\.\.source\.drop\}/u);
    assert.match(source, /className=\{facsimilePaper\(/u);
    assert.match(source, /prepareFacsimilePng\(file\)/u);
    // One copy of the words and of the plain <img>, in the shared module.
    assert.doesNotMatch(source, /FACSIMILE_TYPE|Нужен файл PNG|<img\b|eslint-disable/u);
    assert.doesNotMatch(source, /outline-none|focus(?:-visible)?:ring-/u);
  }
  // The legacy tiles keep their names, their endpoint and what a test clicks on.
  assert.match(legacy, /export type DocumentImageSlot = \{/u);
  assert.match(legacy, /export function DocumentImageTiles</u);
  assert.match(
    legacy,
    /aria-label=\{`\$\{slot\.label\}: \$\{slot\.present \? 'заменить' : 'загрузить'\}`\}/u,
  );
  assert.match(legacy, /aria-label=\{`\$\{slot\.label\}: убрать`\}/u);
  assert.match(legacy, /`\/api\/admin\/settings\/certificate\/image\?kind=\$\{kind\}`/u);
  assert.match(legacy, /<div className="grid grid-cols-2 gap-3">/u);
  assert.match(
    legacy,
    /<p role="alert" className="min-h-5 text-sm text-\[var\(--color-danger\)\]">/u,
  );
});

test('the profile fields show who signs, not links to files, and keep what is typed', async () => {
  const profile = await read(PROFILE);
  assert.doesNotMatch(profile, /Подпись PNG|Печать PNG|registeredDocumentAssetUrl|<a\s|href=/u);
  assert.doesNotMatch(profile, /<details|<summary|rounded-xl border/u);
  for (const text of ['Председатель', 'Член комиссии', 'Подпись есть', 'Подписи нет']) {
    assert.ok(profile.includes(`'${text}'`), text);
  }
  assert.match(profile, /\{place === 0 \? 'Председатель' : 'Член комиссии'\}/u);
  assert.match(profile, /\{person\.assetId \? 'Подпись есть' : 'Подписи нет'\}/u);
  // The rows are read from the stored profile, so a replaced signature shows at once.
  assert.match(profile, /\{profile\.commission\.map\(\(person, place\) => \(/u);
  assert.match(profile, /<p className="font-medium">\{person\.name\}<\/p>/u);
  assert.match(profile, /\{person\.position\}/u);
  // The body is what a Section of the form takes; the name the form has always mounted is the same thing.
  assert.match(
    profile,
    /export function DocumentProfileFieldsBody\(\{ profile, onSaved \}: ProfileFieldsProps\)/u,
  );
  assert.match(profile, /export const DocumentProfileFields = DocumentProfileFieldsBody;/u);
  assert.match(profile, /return \(\s*<div className="grid min-w-0 gap-3">/u);
  assert.doesNotMatch(profile, /<h[1-6]|<section/u);
  // A new revision or new bindings arrive as props; only the typed text is local.
  assert.match(profile, /const \[draft, setDraft\] = useState\(stored\);/u);
  assert.match(profile, /setDraft\(follow\(draft, base, stored\)\);/u);
  assert.ok(
    squeeze(profile).includes(
      squeeze(`body: JSON.stringify({
          profile: { ...profile, ...draft },
          expectedVersion: profile.revision ?? 1,
        })`),
    ),
  );
  assert.match(profile, /clientFetch\('\/api\/admin\/documents\/profiles', \{\s*method: 'PATCH',/u);
  for (const label of [
    'Программа',
    'Часы',
    'Срок, месяцев',
    'Номер приказа',
    'Дата приказа',
    'Вид проверки знаний',
    'Основание проверки',
    'Решение комиссии',
    'Сохранить профиль',
  ]) {
    assert.ok(profile.includes(label), label);
  }
  assert.match(profile, /<p role="status" className="min-h-5 /u);
});
