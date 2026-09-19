import type { PDFFont } from 'pdf-lib';
import type {
  CertificateBranding,
  CertificateRenderMetadata,
} from './certificate-client-contract.ts';
import { formatIssueDate, measureSpan, spanStart } from './certificate-renderer.ts';
import { normalizePdfText, safeFilenameSegment } from './certificate.ts';
import {
  documentCommission,
  documentStatement,
  participantResult,
  type DocumentParticipant,
} from './document-editor.ts';
import { protocolColumns } from './document-profile.ts';

export type ProtocolGroup = Readonly<{
  organization: string | null;
  courseTitle: string;
  items: readonly CertificateRenderMetadata[];
  participants?: readonly DocumentParticipant[];
  date?: string;
  groupNumber?: number;
}>;

export function groupItemsForProtocols(
  items: readonly CertificateRenderMetadata[],
): ProtocolGroup[] {
  const groups = new Map<
    string,
    { organization: string | null; courseTitle: string; items: CertificateRenderMetadata[] }
  >();
  for (const item of items) {
    const organization = item.organization ? normalizePdfText(item.organization) : null;
    const key = JSON.stringify([
      organization?.toLocaleLowerCase('ru-RU'),
      item.titleSnapshot,
      item.branding,
    ]);
    const group = groups.get(key) ?? { organization, courseTitle: item.titleSnapshot, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].map((group, index) => ({ ...group, groupNumber: index + 1 }));
}
export function protocolFilename(group: ProtocolGroup, protocolNumber: string) {
  return `protocols/Протокол-${safeFilenameSegment(protocolNumber || 'без-номера', 24)}-${safeFilenameSegment(group.organization ?? 'без-компании', 48)}-${safeFilenameSegment(group.courseTitle, 48)}${group.groupNumber ? '-' + group.groupNumber : ''}.pdf`;
}

/**
 * What the font itself would answer, without asking it twice. An embedded font
 * shapes the whole string for every measurement, and a width is that one sum
 * scaled by the size — so the sum is kept per font and string, and a block that
 * tries seventeen sizes shapes its text once. The first answer of every font is
 * checked against the font's own; a font that disagrees is simply asked directly.
 */
const measuredText = new WeakMap<PDFFont, Map<string, number> | null>();
export function documentTextWidth(font: PDFFont, text: string, size: number): number {
  let known = measuredText.get(font);
  if (known === null) return font.widthOfTextAtSize(text, size);
  if (known === undefined) {
    const probe = 'Протокол 0123 Wg';
    known =
      font.widthOfTextAtSize(probe, 1000) * (11.25 / 1000) === font.widthOfTextAtSize(probe, 11.25)
        ? new Map()
        : null;
    measuredText.set(font, known);
    if (known === null) return font.widthOfTextAtSize(text, size);
  }
  let total = known.get(text);
  if (total === undefined) {
    total = font.widthOfTextAtSize(text, 1000);
    known.set(text, total);
  }
  return total * (size / 1000);
}

/** Splits even unspaced names, without truncating any characters. */
export function wrapDocumentText(
  font: PDFFont,
  text: string,
  size: number,
  width: number,
): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of normalizePdfText(text).split(' ')) {
    if (line && documentTextWidth(font, line + ' ' + word, size) > width) {
      lines.push(line);
      line = '';
    }
    // A word that fits is taken whole. Measuring it letter by letter shaped the
    // growing line once per character — a thirteen-person protocol spent most of
    // a second here on every keystroke. Only a word wider than the column is
    // still broken between letters.
    const next = line ? line + ' ' + word : word;
    if (documentTextWidth(font, next, size) <= width) {
      line = next;
      continue;
    }
    for (const character of (line ? ' ' : '') + word) {
      if (line && documentTextWidth(font, line + character, size) > width) {
        lines.push(line);
        line = '';
      }
      line += character;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

export async function generateProtocolInBrowser(
  group: ProtocolGroup,
  branding: CertificateBranding,
  fontUrl: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const jobStarted = spanStart();
  const [
    { PDFDocument },
    fontkitModule,
    { loadDocumentFonts, block, rule, ink, embedFacsimile, drawFacsimile },
  ] = await Promise.all([
    import('pdf-lib'),
    import('@pdf-lib/fontkit'),
    import('./document-layout.ts'),
  ]);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkitModule.default);
  const fontsStarted = spanStart();
  const fonts = await loadDocumentFonts(pdf, fontUrl, group.items[0]?.verificationUrl, signal);
  measureSpan('doc:fonts', fontsStarted);
  let page = pdf.addPage([595.28, 841.89]),
    y = 22;
  const nextPage = () => {
    page = pdf.addPage([595.28, 841.89]);
    y = 34;
  };
  const paragraph = (
    text: string,
    size = 11,
    align: 'left' | 'center' | 'right' = 'left',
    bold = false,
    underline = false,
    caption?: string,
  ) => {
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
    if (caption) {
      block(page, caption, fonts.regular, 48, y, 499, 16, 7.5, align, 7.5);
      y += 17;
    }
  };
  const date = new Date(
    (group.date ??
      branding.protocolDate ??
      group.items[0]?.issuedAt?.slice(0, 10) ??
      new Date().toISOString().slice(0, 10)) + 'T12:00:00+05:00',
  );
  pdf.setTitle('Протокол № ' + branding.protocolNumber + ' — ' + group.courseTitle);
  pdf.setAuthor(branding.organizationName);
  paragraph(
    branding.organizationName,
    12,
    'center',
    true,
    true,
    '(Наименование учебной организации)',
  );
  paragraph('Протокол № ' + branding.protocolNumber, 12, 'center', true);
  paragraph('заседания комиссии по проверке знаний', 12, 'center', true);
  y += 14;
  const companyName = group.organization ?? '';
  const companySize = Math.max(
    9,
    Math.min(
      12,
      (499 * 12) / Math.max(1, fonts.pick(companyName, true).widthOfTextAtSize(companyName, 12)),
    ),
  );
  paragraph(companyName, companySize, 'center', true, true, '(наименование компании)');
  paragraph(formatIssueDate(date), 12, 'right', true);
  y += 10;
  paragraph(
    'Председатель: ' + branding.chairmanName + ' — ' + branding.chairmanPosition,
    11,
    'left',
    false,
    true,
    '(Ф.И.О., должность)',
  );
  paragraph('Члены комиссии:', 11);
  for (const m of documentCommission(branding))
    paragraph(m.name + ' — ' + m.position, 11, 'left', false, true, '(Ф.И.О., должность)');
  paragraph('Проверка знаний проведена', 11);
  if (branding.documentProfile?.hours)
    paragraph('Объём программы: ' + branding.documentProfile.hours + ' часов.', 11);
  if (branding.documentProfile?.orderNumber)
    paragraph(
      'Приказ № ' +
        branding.documentProfile.orderNumber +
        (branding.documentProfile.orderDate ? ' от ' + branding.documentProfile.orderDate : ''),
      11,
    );
  paragraph(
    documentStatement(
      branding.documentDefaults?.protocolText ??
        'В соответствии с утвержденной программой на тему: «{program}»',
      branding,
      group.courseTitle,
    ).replace(/^Проверка знаний проведена\s*/u, ''),
    11,
    'center',
    false,
    true,
    '(Наименование программы)',
  );
  paragraph('РЕЗУЛЬТАТЫ ПРОВЕРКИ', 12, 'center', true);
  y += 12;
  const family = branding.documentProfile?.family ?? 'general';
  const columns =
    family === 'ptm'
      ? [26, 96, 72, 94, 73, 60, 80]
      : family === 'biot' || family === 'qualification'
        ? [26, 110, 95, 80, 85, 105]
        : [30, 133, 150, 98, 90];
  const left = (595.28 - 501) / 2;
  const header = protocolColumns(family, branding.protocolLayoutVersion);
  const row = (cells: string[], isHeader = false) => {
    const size = columns.length > 5 ? 9 : 10;
    const wrapped = cells.map((text, i) =>
      wrapDocumentText(fonts.pick(text), text, size, columns[i]! - 10),
    );
    const height = Math.max(...wrapped.map((lines) => lines.length)) * 12 + 10;
    if (height > 720) throw new Error('DOCUMENT_TEXT_OVERFLOW');
    if (y + height > 785) {
      nextPage();
      if (!isHeader) row(header, true);
    }
    let x = left;
    cells.forEach((text, i) => {
      page.drawRectangle({
        x,
        y: page.getHeight() - y - height,
        width: columns[i]!,
        height,
        borderColor: ink,
        borderWidth: 0.5,
      });
      block(
        page,
        text,
        fonts.pick(text),
        x + 5,
        y + 4,
        columns[i]! - 10,
        height - 8,
        size,
        i === 1 && !isHeader ? 'left' : 'center',
        size,
      );
      x += columns[i]!;
    });
    y += height;
  };
  row(header, true);
  const people =
    group.participants ??
    group.items.map((item): DocumentParticipant => ({
      userId: item.certificateId,
      fullName: item.fullName,
      position: item.position ?? '',
      education: item.education ?? '',
      status: item.score >= item.passScore ? 'passed' : 'failed',
      score: item.score,
      total: item.total,
      certificateId: item.certificateId,
      ...item.documentDetails,
    }));
  for (const [i, person] of people.entries()) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const base = [String(i + 1) + '.', person.fullName || 'ФИО не указано'];
    const org = person.organization ?? group.organization ?? '';
    if (family === 'ptm')
      row([
        ...base,
        person.position,
        org,
        person.trainingReason ?? '',
        participantResult(person),
        '',
      ]);
    else if (family === 'biot')
      row([
        ...base,
        org,
        person.position,
        person.status === 'passed' ? 'Прошёл' : 'Подлежит повторной проверке',
        person.notes ?? '',
      ]);
    else if (family === 'qualification')
      row([
        ...base,
        org,
        person.position,
        participantResult(person),
        person.qualificationDecision ?? '',
      ]);
    else if (family === 'industrial')
      row([
        ...base,
        person.position,
        person.education ?? '',
        person.formalExamResult === 'passed'
          ? `Сдал. ${person.formalExamReference ?? ''}${person.formalExamDate ? ' от ' + person.formalExamDate : ''}`
          : 'Отдельный экзамен не подтверждён',
      ]);
    else if (family === 'first-aid' && branding.protocolLayoutVersion === 2)
      row([...base, person.position, org, participantResult(person)]);
    else row([...base, person.position, person.education ?? '', participantResult(person)]);
  }
  if (!people.length) {
    y += 12;
    paragraph('В компании нет участников.');
  }
  y += 20;
  paragraph(
    branding.documentProfile?.decisionText ||
      'Результаты проверки знаний зафиксированы настоящим протоколом. Допуск к самостоятельной работе оформляет работодатель в установленном порядке.',
  );
  y += 20;
  const facsimilesStarted = spanStart();
  const [stamp, ...signatures] = await Promise.all([
    embedFacsimile(pdf, branding.stampUrl, group.items[0]?.verificationUrl, signal),
    ...(branding.commissionSignatureUrls ?? [branding.protocolSignatureUrl ?? null]).map((url) =>
      embedFacsimile(pdf, url, group.items[0]?.verificationUrl, signal),
    ),
  ]);
  measureSpan('doc:facsimiles', facsimilesStarted);
  // The stamp hangs 60 pt below the chairman's line; it must not leave the sheet.
  if ((stamp || signatures.some(Boolean)) && y + 120 > 790) nextPage();
  paragraph('Қолы / Подпись:', 9, 'left', true);
  for (const [i, m] of [
    { name: branding.chairmanName, position: 'Төраға / Председатель' },
    ...documentCommission(branding).map((m) => ({
      name: m.name,
      position: 'Мүшесі / Член комиссии',
    })),
  ].entries()) {
    if (y + 28 > 790) nextPage();
    paragraph(m.position + ': ' + m.name, 9);
    rule(page, 400, y - 6, 135);
    if (i === 0) {
      // A 38 mm stamp at its real size beside the chairman's signature.
      drawFacsimile(page, stamp, 318, y - 54, 108, 108);
    }
    drawFacsimile(page, signatures[i] ?? null, 412, y - 40, 112, 42);
    y += 9;
  }
  if (branding.documentDefaults?.reviewerName)
    paragraph('Проверяющий: ' + branding.documentDefaults.reviewerName, 9);
  y += 14;
  paragraph('Проведение обучения в установленном порядке подтверждаю, замечаний нет', 8);
  paragraph('Куратор Заказчика (подпись, ФИО)', 8);
  rule(page, 260, y - 6, 180);
  for (const [i, sheet] of pdf.getPages().entries()) {
    if (pdf.getPageCount() > 1)
      block(
        sheet,
        String(i + 1) + ' / ' + pdf.getPageCount(),
        fonts.regular,
        500,
        813,
        48,
        12,
        8,
        'right',
      );
  }
  const saveStarted = spanStart();
  const bytes = await pdf.save({ useObjectStreams: true });
  measureSpan('doc:save', saveStarted);
  measureSpan('doc:job', jobStarted);
  return bytes;
}
