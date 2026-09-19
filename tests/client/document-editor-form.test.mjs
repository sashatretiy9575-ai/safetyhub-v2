import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = async (file) =>
  // The working tree is CRLF on Windows; the patterns below are written for LF.
  (await readFile(new URL(`../../${file}`, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const FORM = 'components/admin/certificate-settings-form.tsx';

test('the preview on the screen is the job that is asked for, or it is not offered for download', async () => {
  const form = await read(FORM);
  // Bytes and messages are derived from the job; nothing sets them on the side.
  assert.doesNotMatch(form, /setBytes\(|setPreviewMessage\(|renderKey/u);
  assert.match(form, /const fresh = shown\?\.key === key;/u);
  assert.match(form, /const ready = fresh && !previewMessage && !busy && !working && valid/u);
  assert.match(form, /<DocumentPdfPreview bytes=\{bytes\} pending=\{pending\} \/>/u);
  assert.match(form, /\}, \[key, previewRetry\]\);/u);
  // The wait is judged against what is shown, the pause against what was asked last.
  assert.match(form, /: isDiscreteChange\(shown\?\.job, job\)\n\s+\? 'replace'\n\s+: 'refresh';/u);
  // A choice waits briefly, typing longer. At 0 ms six quick employee picks each started
  // a generation that cannot be interrupted: 3.5 s of main-thread work against 0.7 s.
  assert.match(form, /isDiscreteChange\(previous, job\) \? DISCRETE_RENDER_DELAY_MS : 300,/u);
  const delay = Number(form.match(/const DISCRETE_RENDER_DELAY_MS = (\d+);/u)?.[1]);
  assert.ok(delay >= 100 && delay <= 200, `a choice must fold a burst yet read as instant: ${delay}`);
  // A shared download is never tied to the signal of the preview that started it.
  assert.match(
    form,
    /caches\.photos\.get\(url, \(\) => loadCertificatePhotoBytes\(url\), signal\)/u,
  );
  assert.match(
    form,
    /\.get\(selectedCertificate, \(\) => metadataFor\(selectedCertificate\), controller\.signal\)/u,
  );
  // Drawn without its photo: shown, said, never kept.
  assert.match(form, /if \(!photoFailed\) caches\.bytes\.set\(key, result\);/u);
  assert.match(form, /fresh && shown\?\.photoFailed \? <p role="status">Фото не загрузилось<\/p>/u);
  // «Повторить» asks the server again instead of showing what it kept.
  const retry = form.slice(form.indexOf('aria-label="Повторить предпросмотр"'));
  assert.match(retry, /caches\.bytes\.delete\(key\);/u);
  assert.match(retry, /caches\.photos\.delete\(lastPhotoUrl\.current\);/u);
  assert.match(retry, /caches\.metadata\.delete\(selectedCertificate\);/u);
  // A choice of another company or program forgets all three.
  const reload = form.slice(form.indexOf('loadedSelection.current = selection;'));
  for (const cache of ['photos', 'metadata', 'bytes']) {
    assert.ok(reload.indexOf(`caches.${cache}.clear();`) < reload.indexOf('setData(next);'), cache);
  }
});

test('a quota answer is worded in seconds, and a company kit waits it out under «Отменить»', async () => {
  const form = await read(FORM);
  assert.match(
    form,
    /if \(response\.status === 429\)\n\s+throw new RetryLater\(retryAfterSeconds\(response\.headers\.get\('Retry-After'\)\)\);/u,
  );
  assert.match(form, /`Повторите через \$\{error\.seconds\} с`/u);
  assert.match(form, /if \(!\(error instanceof RetryLater\) \|\| waits >= 3\) throw error;/u);
  assert.match(form, /await abortableDelay\(error\.seconds \* 1000, signal\);/u);
  assert.match(form, /setMessage\(`Корочек: \$\{count\}, пауза \$\{seconds\} с`\)/u);
  assert.match(
    form,
    /controller\.signal\.aborted\n\s+\? 'Отменено'\n\s+: error instanceof RetryLater\n\s+\? retryLaterMessage\(error\)\n\s+: 'Не скачано, повторите'/u,
  );
  assert.match(
    form,
    /error instanceof RetryLater \? retryLaterMessage\(error\) : 'Удостоверение недоступно'/u,
  );
});

test('a swipe between the halves is mostly horizontal', async () => {
  const form = await read(FORM);
  assert.match(form, /Math\.abs\(dx\) > 48 && Math\.abs\(dx\) > 2 \* Math\.abs\(dy\)/u);
});

test('names say what they name, switches name their halves, and nothing is explained in sentences', async () => {
  const form = await read(FORM);
  assert.match(form, /<Field label="Дата протокола">\n\s+<Input\n\s+type="date"\n\s+aria-label="Дата протокола"/u);
  assert.match(form, /const NUMBER_FOLLOWS_DATE = ' · по дате';/u);
  assert.match(form, /label="Номер протокола"\n\s+state=\{\{ text: NUMBER_FOLLOWS_DATE, on: batch\.automatic \}\}/u);
  // What a screen reader hears is what is written above the field.
  assert.match(
    form,
    /aria-label=\{'Номер протокола' \+ \(batch\.automatic \? NUMBER_FOLLOWS_DATE : ''\)\}/u,
  );
  // The room of the suffix is kept: the field does not move under the hand that types.
  assert.match(form, /<span className=\{cn\(!state\.on && 'invisible'\)\}>\{state\.text\}<\/span>/u);
  assert.match(form, /title=\{'Номер по дате: ' \+ numberFromDate\(batch\.date\)\}/u);
  assert.match(form, /aria-label="Вернуть сохранённые дату и номер протокола"/u);
  // Typing a number is the only thing that stops it following the date.
  assert.equal(form.match(/automatic: false/gu)?.length, 1);
  assert.equal(form.match(/automatic: true/gu)?.length, 1);

  assert.match(form, /<SegmentedControl\n\s+label="Документ"/u);
  assert.match(form, /value: 'fields',\n\s+label: 'Поля',/u);
  assert.match(form, /label="Половина разворота"/u);
  assert.match(form, /\{ value: 'left', label: 'Левая половина' \},\n\s+\{ value: 'right', label: 'Правая половина' \},/u);
  assert.match(form, /'Общая ширина разворота, см'/u);

  // One chip over the pages, in a line that is there whoever is chosen.
  assert.match(form, /<Badge>Новая выдача<\/Badge>/u);
  assert.match(
    form,
    /Выдано \{issueDay\.format\(new Date\(metadata\.issuedAt\)\)\} · № \{metadata\.certificateNumber\}/u,
  );
  assert.match(form, /<div role="status" className="flex min-h-12 min-w-0 items-center">\n\s+\{issuance\}/u);

  for (const gone of [
    'Вид документа',
    "label: 'Изменить'",
    'Сторона удостоверения',
    'Выданный документ сохраняет',
    'Удостоверение ещё не выдано',
    'Вкладыш в развёрнутом виде',
    'Образование нужно для новой выдачи этой формы',
    'Печать и подпись',
  ]) {
    assert.ok(!form.includes(gone), gone);
  }
  // Reference data for whoever writes the texts stays where the texts are.
  assert.match(form, /\{program\} — программа, \{protocol\} — номер протокола/u);
  // The owner's rule on focus: one state, drawn by the primitives.
  assert.doesNotMatch(form, /focus(?:-visible)?:ring-|outline-none/u);
});

test('«Подписи и печать» is one section: the registry where programs have profiles, the settings’ own tiles where they have none', async () => {
  const [form, page] = await Promise.all([
    read(FORM),
    read('app/(admin)/admin/settings/certificate/page.tsx'),
  ]);
  assert.match(form, /const governed = Boolean\(branding\.documentProfile\);/u);
  assert.match(
    form,
    /const legacyMode = course \? !governed && !audienceRequired : profiles\.length === 0;/u,
  );
  assert.equal(form.match(/title="Подписи и печать"/gu)?.length, 1);
  // Never both: one branch of one condition each.
  assert.match(
    form,
    /\{legacyMode \? \(\n\s+<DocumentImageTiles<CertificateSettingsView>[\s\S]+?\) : \(\n\s+<DocumentAssetRegistry\n\s+entries=\{registry\}\n\s+disabled=\{busy\}/u,
  );
  assert.equal(form.match(/<DocumentImageTiles</gu)?.length, 1);
  assert.equal(form.match(/<DocumentAssetRegistry\n/gu)?.length, 1);
  assert.match(
    form,
    /buildDocumentAssetRegistry\(profiles, assets, branding\.documentProfile\?\.id\)/u,
  );
  assert.match(form, /: registry\.some\(\(entry\) => entry\.behind\.length\)\n\s+\? 'Не во всех программах'\n\s+: 'Загружены';/u);
  // A replacement hands back every profile and the new image; the form takes both in.
  assert.match(form, /onReplaced=\{\(\{ asset, profiles: next \}\) => \{\n\s+setProfiles\(next\);/u);
  assert.match(form, /current\.some\(\(known\) => known\.id === asset\.id\)/u);

  // The profile owns the commission, the term and the protocol's text of its program.
  assert.match(form, /title=\{governed \? 'Организация' : 'Организация и комиссия'\}/u);
  assert.match(form, /\{governed \? null : \(\n\s+<div [^>]+>\n\s+\{textField\('chairmanName', 'Председатель'\)\}/u);
  assert.match(form, /\{governed \? null : \(\n\s+<>\n\s+\{commission\.map\(/u);
  assert.match(form, /\{tab === 'protocol' && governed \? null : \(\n\s+<Section\n\s+icon=\{<TextAa/u);
  assert.match(form, /const legacyTerm = !governed \|\| !valid;/u);
  // Its fields live in a section of their own and keep what is typed across a new revision.
  assert.match(form, /title="Реквизиты программы и комиссия"/u);
  assert.match(form, /<DocumentProfileFields\n\s+key=\{branding\.documentProfile\.id\}/u);
  assert.match(form, /open=\{sections\.has\('profile'\)\}\n\s+keepMounted/u);
  assert.match(form, /const SECTION_IDS = \['profile', 'images', 'commission', 'texts', 'size'\] as const;/u);

  // Where programs have profiles, no program means no document rather than a sample nobody issues.
  assert.match(
    form,
    /!course && profiles\.length\n\s+\? \{ kind: 'message', text: CHOOSE_DOCUMENT \}\n\s+: audienceRequired\n\s+\? \{ kind: 'message', text: CHOOSE_AUDIENCE \}\n\s+: buildPreviewJob\(\{/u,
  );
  assert.match(form, /const CHOOSE_DOCUMENT = 'Выберите компанию, программу и сотрудника';/u);
  // A program split into workers and engineers binds nothing until the category is
  // chosen. Drawing the settings' commission there produced a document with neither
  // the stamp nor the signatures, while the database refuses to issue it at all.
  assert.match(
    form,
    /const audienceRequired =\n\s+Boolean\(course\) && !governed && profiles\.some\(\(p\) => p\.courseSlug === course\);/u,
  );
  assert.match(form, /const CHOOSE_AUDIENCE =\n\s+'Выберите категорию слушателей/u);

  // The index follows the profiles it is read for; the other two reads wait for neither.
  assert.match(
    page,
    /readDocumentProfiles\(\)\.then\(async \(profiles\) => \(\{ profiles, assets: await readDocumentAssetIndex\(profiles\) \}\)\)/u,
  );
  assert.match(page, /profiles=\{profiles\} assets=\{assets\}/u);
});

test('the message for a program not chosen is the one the preview job already has', async () => {
  const job = await read('lib/pdf/document-preview-job.ts');
  assert.match(job, /text: 'Выберите компанию, программу и сотрудника'/u);
});
