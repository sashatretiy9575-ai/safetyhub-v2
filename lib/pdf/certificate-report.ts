import type { PDFFont, PDFPage, RGB } from 'pdf-lib';
import type { CertificateRenderMetadata } from './certificate-client-contract.ts';
import { normalizePdfText } from './certificate.ts';

export type CertificateReportRow = Readonly<{
  fullName: string;
  position: string | null;
  organization: string | null;
  courseTitle: string;
  score: number;
  total: number;
  completedAt: Date;
  issuedAt: Date;
  certificateNumber: string;
}>;

const A4_LANDSCAPE: [number, number] = [841.89, 595.28];
const MARGIN = 32;
const HEADER_HEIGHT = 48;
const ROW_HEIGHT = 34;
const FOOTER_HEIGHT = 24;

type Column = Readonly<{
  label: string;
  width: number;
  value: (row: CertificateReportRow) => string;
}>;

const COLUMNS: readonly Column[] = [
  { label: 'ФИО', width: 123, value: (row) => row.fullName },
  { label: 'Должность', width: 93, value: (row) => row.position ?? '—' },
  { label: 'Компания', width: 98, value: (row) => row.organization ?? '—' },
  { label: 'Курс', width: 123, value: (row) => row.courseTitle },
  { label: 'Результат', width: 65, value: (row) => `${row.score} / ${row.total}` },
  {
    label: 'Прохождение',
    width: 82,
    value: (row) => row.completedAt.toLocaleDateString('ru-KZ', { timeZone: 'Asia/Oral' }),
  },
  {
    label: 'Выдача',
    width: 76,
    value: (row) => row.issuedAt.toLocaleDateString('ru-KZ', { timeZone: 'Asia/Oral' }),
  },
  // The generated number has a fixed `SH-YYYY-XXXXXXXXXXXX` shape. Keep the
  // entire value visible because it is the document's primary lookup key.
  { label: '№ сертификата', width: 117, value: (row) => row.certificateNumber },
];

function fitText(font: PDFFont, value: string, size: number, maxWidth: number) {
  const normalized = normalizePdfText(value);
  if (font.widthOfTextAtSize(normalized, size) <= maxWidth) return normalized;
  const ellipsis = '…';
  const points = Array.from(normalized);
  let lower = 0;
  let upper = points.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    const candidate = `${points.slice(0, middle).join('')}${ellipsis}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) lower = middle;
    else upper = middle - 1;
  }
  return `${points.slice(0, lower).join('')}${ellipsis}`;
}

function drawCell(
  page: PDFPage,
  font: PDFFont,
  value: string,
  x: number,
  y: number,
  width: number,
  ink: RGB,
) {
  const size = 8;
  page.drawText(fitText(font, value, size, width - 12), {
    x: x + 6,
    y: y + (ROW_HEIGHT - size) / 2 - 1,
    size,
    font,
    color: ink,
  });
}

export function certificateReportRows(
  items: readonly CertificateRenderMetadata[],
): CertificateReportRow[] {
  return items.map((item) => ({
    fullName: item.fullName,
    position: item.position,
    organization: item.organization,
    courseTitle: item.titleSnapshot,
    score: item.score,
    total: item.total,
    completedAt: new Date(item.completedAt),
    issuedAt: new Date(item.issuedAt),
    certificateNumber: item.certificateNumber,
  }));
}

export async function generateCertificateReportInBrowser(
  sourceRows: readonly CertificateReportRow[],
  createdAt: Date,
  fontBytes: Uint8Array,
  subsetFont = false,
): Promise<Uint8Array> {
  if (sourceRows.length > 500) throw new Error('CERTIFICATE_REPORT_SIZE_INVALID');
  const [{ PDFDocument, rgb }, fontkitModule] = await Promise.all([
    import('pdf-lib'),
    import('@pdf-lib/fontkit'),
  ]);
  const rows = sourceRows.map((row) => ({
    ...row,
    fullName: normalizePdfText(row.fullName),
    position: row.position ? normalizePdfText(row.position) : null,
    organization: row.organization ? normalizePdfText(row.organization) : null,
    courseTitle: normalizePdfText(row.courseTitle),
    certificateNumber: normalizePdfText(row.certificateNumber),
  }));
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkitModule.default);
  const font = await pdf.embedFont(fontBytes, { subset: subsetFont });
  pdf.setTitle('Отчёт по выданным сертификатам SafetyHub.kz');
  pdf.setSubject('Сводный отчёт об аттестации');
  pdf.setAuthor('SafetyHub.kz');
  pdf.setCreator('SafetyHub.kz');
  pdf.setProducer('SafetyHub.kz');
  pdf.setCreationDate(createdAt);
  pdf.setModificationDate(createdAt);

  const green = rgb(0.07, 0.49, 0.16);
  const greenDark = rgb(0.03, 0.28, 0.1);
  const greenPale = rgb(0.93, 0.98, 0.94);
  const ink = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.37, 0.42, 0.47);
  const border = rgb(0.82, 0.87, 0.83);
  const tableTop = A4_LANDSCAPE[1] - 112;
  const tableBottom = FOOTER_HEIGHT + 12;
  const rowsPerPage = Math.max(
    1,
    Math.floor((tableTop - tableBottom - HEADER_HEIGHT) / ROW_HEIGHT),
  );
  const pageCount = Math.max(1, Math.ceil(rows.length / rowsPerPage));

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const page = pdf.addPage(A4_LANDSCAPE);
    const { width, height } = page.getSize();
    page.drawRectangle({ x: 0, y: height - 88, width, height: 88, color: greenDark });
    page.drawText('SafetyHub.kz', {
      x: MARGIN,
      y: height - 36,
      size: 21,
      font,
      color: rgb(1, 1, 1),
    });
    page.drawText('Отчёт по выданным сертификатам', {
      x: MARGIN,
      y: height - 64,
      size: 13,
      font,
      color: rgb(0.85, 0.96, 0.87),
    });
    const metadata = `${createdAt.toLocaleDateString('ru-KZ', { timeZone: 'Asia/Oral' })} · участников: ${rows.length}`;
    page.drawText(metadata, {
      x: width - MARGIN - font.widthOfTextAtSize(metadata, 9),
      y: height - 48,
      size: 9,
      font,
      color: rgb(0.85, 0.96, 0.87),
    });

    let x = MARGIN;
    const tableHeaderY = tableTop - HEADER_HEIGHT;
    page.drawRectangle({
      x: MARGIN,
      y: tableHeaderY,
      width: A4_LANDSCAPE[0] - MARGIN * 2,
      height: HEADER_HEIGHT,
      color: green,
    });
    for (const column of COLUMNS) {
      page.drawText(fitText(font, column.label, 8, column.width - 12), {
        x: x + 6,
        y: tableHeaderY + 19,
        size: 8,
        font,
        color: rgb(1, 1, 1),
      });
      x += column.width;
    }

    const pageRows = rows.slice(pageIndex * rowsPerPage, (pageIndex + 1) * rowsPerPage);
    if (pageRows.length === 0) {
      page.drawText('Действующих сертификатов в выбранных строках нет.', {
        x: MARGIN,
        y: tableTop - HEADER_HEIGHT - ROW_HEIGHT,
        size: 10,
        font,
        color: muted,
      });
    }
    pageRows.forEach((row, index) => {
      const y = tableTop - HEADER_HEIGHT - (index + 1) * ROW_HEIGHT;
      page.drawRectangle({
        x: MARGIN,
        y,
        width: A4_LANDSCAPE[0] - MARGIN * 2,
        height: ROW_HEIGHT,
        color: index % 2 === 0 ? rgb(1, 1, 1) : greenPale,
        borderColor: border,
        borderWidth: 0.35,
      });
      let rowX = MARGIN;
      for (const column of COLUMNS) {
        drawCell(page, font, column.value(row), rowX, y, column.width, ink);
        rowX += column.width;
      }
    });

    const footer = `Страница ${pageIndex + 1} из ${pageCount}`;
    page.drawText(footer, {
      x: width - MARGIN - font.widthOfTextAtSize(footer, 8),
      y: 16,
      size: 8,
      font,
      color: muted,
    });
    page.drawText('Сформировано SafetyHub.kz', {
      x: MARGIN,
      y: 16,
      size: 8,
      font,
      color: muted,
    });
  }

  return pdf.save({ useObjectStreams: true });
}
