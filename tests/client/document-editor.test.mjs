import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { documentDate, numberFromDate, newDocumentBatch, changeDocumentDate, DOCUMENT_DEFAULTS } from '../../lib/pdf/document-editor.ts';
import { generateProtocolInBrowser } from '../../lib/pdf/protocol-renderer.ts';
import { generateCertificateInBrowser } from '../../lib/pdf/certificate-renderer.ts';

async function renderPageForReview(page, filename) {
  if (!process.env.DOCUMENT_EDITOR_VISUAL_QA) return;
  const { createCanvas } = await import('@napi-rs/canvas');
  const viewport = page.getViewport({ scale: 1.4 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
  await mkdir('test-results/document-editor-layout', { recursive: true });
  await writeFile('test-results/document-editor-layout/' + filename, canvas.toBuffer('image/png'));
}

test('protocol date follows Oral midnight and manual numbers survive date changes', () => {
  assert.equal(documentDate(new Date('2026-09-08T18:59:59Z')), '2026-09-08');
  assert.equal(documentDate(new Date('2026-09-08T19:00:00Z')), '2026-09-09');
  assert.equal(numberFromDate('2026-01-02'), '02.01');
  const batch = newDocumentBatch('Компания', 'biot');
  assert.equal(changeDocumentDate(batch, '2026-09-08').number, '08.09');
  assert.equal(changeDocumentDate({ ...batch, number: 'CUSTOM/1', automatic: false }, '2026-09-08').number, 'CUSTOM/1');
});

// The smallest PNG there is; DOCUMENT_EDITOR_STAMP_PNG / DOCUMENT_EDITOR_SIGNATURE_PNG
// put real pictures on the visual QA sheets without committing them.
const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
async function facsimile(url) {
  const file = url.includes('kind=stamp') ? process.env.DOCUMENT_EDITOR_STAMP_PNG : process.env.DOCUMENT_EDITOR_SIGNATURE_PNG;
  return file ? readFile(file) : PIXEL_PNG;
}

test('PDFs contain actual results, all company participants, the stamp and the signature of each document', async () => {
  const font = await readFile(new URL('../../lib/pdf/assets/noto-sans-latin-cyrillic.ttf', import.meta.url));
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async input => {
    requests.push(String(input));
    if (String(input).includes('/certificate-assets/image?')) return new Response(await facsimile(String(input)));
    assert.match(String(input), /font/);
    return new Response(String(input).includes('face=serif') ? await readFile(new URL('../../lib/pdf/assets/NotoSerif-' + (String(input).includes('weight=bold') ? 'Bold' : 'Regular') + '.ttf', import.meta.url)) : String(input).includes('face=sans') ? await readFile(new URL('../../lib/pdf/assets/NotoSans-Bold.ttf', import.meta.url)) : font);
  };
  const branding = {
    organizationName: 'ТОО «Work Safety (Уорк Сэйфти)»', bin: '171140039242', chairmanName: 'Битемиров А.У.', chairmanPosition: 'Директор',
    memberName: '', memberPosition: '', secondMemberName: '', secondMemberPosition: '', protocolNumber: '08.09', protocolDate: '2026-09-08', validityMonths: 12,
    examTextKk: '«{program}» бағдарламасы бойынша емтихан тапсырды. №{protocol} хаттама.', examTextRu: 'сдал (а) экзамен по программе «{program}» на основании протокола №{protocol}',
    knowledgeTextKk: '«{program}» бағдарламасы бойынша білімін тексеру. №{protocol} хаттама.', knowledgeTextRu: 'Проверка знаний по программе «{program}». Протокол №{protocol}.',
    documentDefaults: { ...DOCUMENT_DEFAULTS, insertWidthCm: 32, insertHeightCm: 10 },
    stampUrl: '/certificate-assets/image?kind=stamp&v=1', chairmanSignatureUrl: '/certificate-assets/image?kind=chairman&v=1', memberSignatureUrl: null,
    protocolSignatureUrl: '/certificate-assets/image?kind=protocol&v=1',
  };
  try {
    const participants = Array.from({ length: 130 }, (_, i) => ({
      userId: String(i), fullName: 'Участник ' + String(i + 1).padStart(3, '0') + ' ' + 'Оченьдлиннаяфамилия'.repeat(5),
      position: 'Инженер по охране труда и промышленной безопасности', status: i === 0 ? 'passed' : i === 1 ? 'failed' : 'none',
      score: i === 0 ? 9 : i === 1 ? 3 : null, total: i < 2 ? 10 : null, certificateId: null,
    }));
    const bytes = await generateProtocolInBrowser({ organization: DOCUMENT_DEFAULTS.companyName, courseTitle: 'Работа на высоте', participants, items: [] }, branding, '/certificate-assets/font?locale=ru&v=1');
    const loaded = await PDFDocument.load(bytes);
    assert.ok(loaded.getPageCount() > 3);
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true });
    const pdf = await task.promise;
    let text = '';
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      await renderPageForReview(page, `protocol-${n}.png`);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str + ' ';
        assert.ok(item.transform[4] >= 0 && item.transform[4] + item.width <= 596, 'horizontal clipping');
        assert.ok(item.transform[5] >= 20, 'vertical clipping');
      }
    }
    assert.match(text, /Участник 130/);
    assert.match(text, /Не сдал/);
    assert.match(text, /Проверка не пройдена/);
    assert.match(text, /Образование/);
    await task.destroy();
    // The protocol carries the stamp and its own signature, never the booklet's.
    assert.deepEqual(requests.filter(url => url.includes('image')).map(url => new URL(url, 'https://x').searchParams.get('kind')).sort(), ['protocol', 'stamp']);
    const drawn = loaded.getPages().map(sheet => sheet.node.Resources().lookupMaybe(PDFName.of('XObject'), PDFDict)?.keys().length ?? 0);
    assert.deepEqual(drawn.filter(Boolean), [2], 'both are drawn once, beside the chairman');
    requests.length = 0;
    const certificate = await generateCertificateInBrowser({
      schemaVersion: 1, certificateId: '00000000-0000-4000-8000-000000000001', filename: 'SH-TEST.pdf', locale: 'ru',
      templateVersion: 1, templateUrl: '/certificates/template-v1.pdf', fontUrl: '/certificate-assets/font?locale=ru&v=1',
      fullName: 'Тестовый Участник', position: 'Инженер', organization: DOCUMENT_DEFAULTS.companyName,
      titleSnapshot: 'Работа на высоте', score: 9, total: 10, passScore: 7, certificateNumber: 'SH-TEST',
      issuedAt: '2026-09-08T12:00:00Z', completedAt: '2026-09-08T12:00:00Z',
      verificationUrl: 'https://safetyhub.kz/verify/v1.test', branding,
    });
    assert.equal((await PDFDocument.load(certificate)).getPageCount(), 1);
    const certTask = pdfjs.getDocument({ data: certificate.slice(), useSystemFonts: true });
    const certPdf = await certTask.promise;
    let certText = '';
    for (let n = 1; n <= certPdf.numPages; n++) {
      const p = await certPdf.getPage(n);
      await renderPageForReview(p, `booklet-${n}.png`);
      certText += (await p.getTextContent()).items.map(i => i.str ?? '').join(' ');
    }
    assert.match(certText, /08\.09/);
    assert.match(certText, /Работа на высоте/);
    assert.match(certText, /М\.П\./);
    await certTask.destroy();
    assert.deepEqual(requests.filter(url => url.includes('image')).map(url => new URL(url, 'https://x').searchParams.get('kind')).sort(), ['chairman', 'stamp']);
  } finally { globalThis.fetch = original; }
});
