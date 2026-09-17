import type { PDFFont } from 'pdf-lib';
import type { CertificateBranding, CertificateRenderMetadata } from './certificate-client-contract.ts';
import { formatIssueDate } from './certificate-renderer.ts';
import { normalizePdfText, safeFilenameSegment } from './certificate.ts';
import { documentCommission, documentStatement, participantResult, type DocumentParticipant } from './document-editor.ts';

export type ProtocolGroup = Readonly<{
  organization: string | null;
  courseTitle: string;
  items: readonly CertificateRenderMetadata[];
  participants?: readonly DocumentParticipant[];
  date?: string;
}>;

export function groupItemsForProtocols(items: readonly CertificateRenderMetadata[]): ProtocolGroup[] {
  const groups = new Map<string, { organization: string | null; courseTitle: string; items: CertificateRenderMetadata[] }>();
  for (const item of items) {
    const organization = item.organization ? normalizePdfText(item.organization) : null;
    const key = JSON.stringify([organization?.toLocaleLowerCase('ru-RU'), item.titleSnapshot, item.branding.protocolNumber, item.branding.protocolDate]);
    const group = groups.get(key) ?? { organization, courseTitle: item.titleSnapshot, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}
export function protocolFilename(group: ProtocolGroup, protocolNumber: string) {
  return `protocols/Протокол-${safeFilenameSegment(protocolNumber || 'без-номера', 24)}-${safeFilenameSegment(group.organization ?? 'без-компании', 48)}-${safeFilenameSegment(group.courseTitle, 48)}.pdf`;
}

/** Splits even unspaced names, without truncating any characters. */
export function wrapDocumentText(font: PDFFont, text: string, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of normalizePdfText(text).split(' ')) {
    if (line && font.widthOfTextAtSize(line + ' ' + word, size) > width) {
      lines.push(line); line = '';
    }
    for (const character of (line ? ' ' : '') + word) {
      if (line && font.widthOfTextAtSize(line + character, size) > width) {
        lines.push(line); line = '';
      }
      line += character;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}


export async function generateProtocolInBrowser(group: ProtocolGroup, branding: CertificateBranding, fontUrl: string, signal?: AbortSignal): Promise<Uint8Array> {
  const [{ PDFDocument }, fontkitModule, { loadDocumentFonts, block, rule, ink, embedFacsimile, drawFacsimile }] = await Promise.all([import('pdf-lib'), import('@pdf-lib/fontkit'), import('./document-layout.ts')]);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkitModule.default);
  const fonts = await loadDocumentFonts(pdf, fontUrl, group.items[0]?.verificationUrl, signal);
  let page = pdf.addPage([595.28, 841.89]), y = 22;
  const nextPage = () => { page = pdf.addPage([595.28, 841.89]); y = 34; };
  const paragraph = (text: string, size = 11, align: 'left' | 'center' | 'right' = 'left', bold = false, underline = false, caption?: string) => {
    const font = fonts.pick(text, bold);
    const lines = wrapDocumentText(font, text, size, 499);
    const height = lines.length * size * 1.2;
    if (y + height + 28 > 790) nextPage();
    block(page, text, font, 48, y, 499, height + 1, size, align, size);
    if (underline) {
      const lineWidth = lines.length > 1 ? 499 : font.widthOfTextAtSize(text, size);
      rule(page, align === 'center' ? (595.28 - lineWidth) / 2 : 48, y + height, lineWidth);
    }
    y += height + 5;
    if (caption) { block(page, caption, fonts.regular, 48, y, 499, 16, 7.5, align, 7.5); y += 17; }
  };
  const date = new Date((group.date ?? branding.protocolDate ?? group.items[0]?.issuedAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10)) + 'T12:00:00+05:00');
  pdf.setTitle('Протокол № ' + branding.protocolNumber + ' — ' + group.courseTitle);
  pdf.setAuthor(branding.organizationName);
  paragraph(branding.organizationName, 12, 'center', true, true, '(Наименование учебной организации)');
  paragraph('Протокол № ' + branding.protocolNumber, 12, 'center', true);
  paragraph('заседания комиссии по проверке знаний', 12, 'center', true);
  y += 14;
  const companyName = group.organization ?? '';
  const companySize = Math.max(9, Math.min(12, 499 * 12 / Math.max(1, fonts.pick(companyName, true).widthOfTextAtSize(companyName, 12))));
  paragraph(companyName, companySize, 'center', true, true, '(наименование компании)');
  paragraph(formatIssueDate(date), 12, 'right', true);
  y += 10;
  paragraph('Председатель: ' + branding.chairmanName + ' — ' + branding.chairmanPosition, 11, 'left', false, true, '(Ф.И.О., должность)');
  paragraph('Члены комиссии:', 11);
  for (const m of documentCommission(branding)) paragraph(m.name + ' — ' + m.position, 11, 'left', false, true, '(Ф.И.О., должность)');
  paragraph('Проверка знаний проведена', 11);
  paragraph(documentStatement(branding.documentDefaults?.protocolText ?? 'В соответствии с утвержденной программой на тему: «{program}»', branding, group.courseTitle).replace(/^Проверка знаний проведена\s*/u, ''), 11, 'center', false, true, '(Наименование программы)');
  paragraph('РЕЗУЛЬТАТЫ ПРОВЕРКИ', 12, 'center', true);
  y += 12;
  const columns = [30, 133, 150, 98, 90], left = (595.28 - 501) / 2;
  const header = ['№', 'Ф.И.О.', 'Занимаемая должность', 'Образование', 'Результат сдачи экзаменов'];
  const row = (cells: string[], isHeader = false) => {
    const size = 10;
    const wrapped = cells.map((text, i) => wrapDocumentText(fonts.pick(text), text, size, columns[i]! - 10));
    const height = Math.max(...wrapped.map(lines => lines.length)) * 12 + 10;
    if (height > 720) throw new Error('DOCUMENT_TEXT_OVERFLOW');
    if (y + height > 785) { nextPage(); if (!isHeader) row(header, true); }
    let x = left;
    cells.forEach((text, i) => {
      page.drawRectangle({ x, y: page.getHeight() - y - height, width: columns[i]!, height, borderColor: ink, borderWidth: .5 });
      block(page, text, fonts.pick(text), x + 5, y + 4, columns[i]! - 10, height - 8, size, i === 1 && !isHeader ? 'left' : 'center', size);
      x += columns[i]!;
    });
    y += height;
  };
  row(header, true);
  const people = group.participants ?? group.items.map((item): DocumentParticipant => ({
    userId: item.certificateId, fullName: item.fullName, position: item.position ?? '', education: item.education ?? '',
    status: item.score >= item.passScore ? 'passed' : 'failed', score: item.score, total: item.total, certificateId: item.certificateId,
  }));
  for (const [i, person] of people.entries()) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    row([String(i + 1) + '.', person.fullName || 'ФИО не указано', person.position, person.education ?? '', participantResult(person)]);
  }
  if (!people.length) { y += 12; paragraph('В компании нет участников.'); }
  y += 20;
  paragraph('Лица, получившие положительные оценки, допускаются к самостоятельной работе, к выполнению соответствующих работ.');
  y += 20;
  const [stamp, signature] = await Promise.all([
    embedFacsimile(pdf, branding.stampUrl, group.items[0]?.verificationUrl, signal),
    embedFacsimile(pdf, branding.protocolSignatureUrl, group.items[0]?.verificationUrl, signal),
  ]);
  // The stamp hangs 60 pt below the chairman's line; it must not leave the sheet.
  if ((stamp || signature) && y + 120 > 790) nextPage();
  paragraph('Қолы / Подпись:', 9, 'left', true);
  for (const [i, m] of [{ name: branding.chairmanName, position: 'Төраға / Председатель' }, ...documentCommission(branding).map(m => ({ name: m.name, position: 'Мүшесі / Член комиссии' }))].entries()) {
    if (y + 28 > 790) nextPage();
    paragraph(m.position + ': ' + m.name, 9);
    rule(page, 400, y - 6, 135);
    if (i === 0) {
      // A 38 mm stamp at its real size beside the chairman's signature.
      drawFacsimile(page, stamp, 318, y - 54, 108, 108);
      drawFacsimile(page, signature, 412, y - 40, 112, 42);
    }
    y += 9;
  }
  if (branding.documentDefaults?.reviewerName) paragraph('Проверяющий: ' + branding.documentDefaults.reviewerName, 9);
  y += 14;
  paragraph('Проведение обучения в установленном порядке подтверждаю, замечаний нет', 8);
  paragraph('Куратор Заказчика (подпись, ФИО)', 8);
  rule(page, 260, y - 6, 180);
  for (const [i, sheet] of pdf.getPages().entries()) {
    if (pdf.getPageCount() > 1) block(sheet, String(i + 1) + ' / ' + pdf.getPageCount(), fonts.regular, 500, 813, 48, 12, 8, 'right');
  }
  return pdf.save({ useObjectStreams: true });
}
