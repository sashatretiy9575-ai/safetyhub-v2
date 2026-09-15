import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
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

test('PDFs contain actual results, all company participants, no signing blocks or image requests', async () => {
  const font = await readFile(new URL('../../lib/pdf/assets/noto-sans-latin-cyrillic.ttf', import.meta.url));
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async input => {
    requests.push(String(input));
    assert.match(String(input), /font/);
    return new Response(font);
  };
  const branding = {
    organizationName: 'ТОО «Work Safety (Уорк Сэйфти)»', bin: '171140039242', chairmanName: 'Битемиров А.У.', chairmanPosition: 'Директор',
    memberName: '', memberPosition: '', secondMemberName: '', secondMemberPosition: '', protocolNumber: '08.09', protocolDate: '2026-09-08', validityMonths: 12,
    examTextKk: '', examTextRu: 'Программа «{program}». Протокол №{protocol}', knowledgeTextKk: '', knowledgeTextRu: 'Протокол №{protocol}',
    documentDefaults: DOCUMENT_DEFAULTS,
    stampUrl: '/certificate-assets/image?kind=stamp&v=1', chairmanSignatureUrl: '/certificate-assets/image?kind=chairman&v=1', memberSignatureUrl: null,
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
    assert.doesNotMatch(text, /Подпись|подпись|М\.П\.|М\.О\.|____|Куратор Заказчика/);
    await task.destroy();
    const certificate = await generateCertificateInBrowser({
      schemaVersion: 1, certificateId: '00000000-0000-4000-8000-000000000001', filename: 'SH-TEST.pdf', locale: 'ru',
      templateVersion: 1, templateUrl: '/certificates/template-v1.pdf', fontUrl: '/certificate-assets/font?locale=ru&v=1',
      fullName: 'Тестовый Участник', position: 'Инженер', organization: DOCUMENT_DEFAULTS.companyName,
      titleSnapshot: 'Работа на высоте', score: 9, total: 10, passScore: 7, certificateNumber: 'SH-TEST',
      issuedAt: '2026-09-08T12:00:00Z', completedAt: '2026-09-08T12:00:00Z',
      verificationUrl: 'https://safetyhub.kz/verify/v1.test', branding,
    });
    assert.equal((await PDFDocument.load(certificate)).getPageCount(), 2);
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
    assert.doesNotMatch(certText, /Подпись|подпись|М\.П\.|М\.О\.|____/);
    await certTask.destroy();
    assert.ok(requests.every(url => !url.includes('image')));
  } finally { globalThis.fetch = original; }
});
