import { promises as fs } from 'node:fs';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { normalizePdfText } from '@/lib/pdf/certificate';

export type CertificateReportRow = {
  fullName: string;
  position: string | null;
  organization: string | null;
  courseTitle: string;
  score: number;
  total: number;
  completedAt: Date;
  issuedAt: Date;
  certificateNumber: string;
};

const REPORT_FONT_BYTES = fs.readFile(
  path.join(process.cwd(), 'lib', 'pdf', 'assets', 'noto-sans-latin-cyrillic.ttf'),
);
const A4_LANDSCAPE: [number, number] = [841.89, 595.28];
const MARGIN = 32;
const HEADER_HEIGHT = 48;
const ROW_HEIGHT = 34;
const FOOTER_HEIGHT = 24;
const GREEN = rgb(0.07, 0.49, 0.16);
const GREEN_DARK = rgb(0.03, 0.28, 0.1);
const GREEN_PALE = rgb(0.93, 0.98, 0.94);
const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.37, 0.42, 0.47);
const BORDER = rgb(0.82, 0.87, 0.83);

type Column = {
  label: string;
  width: number;
  value: (row: CertificateReportRow) => string;
};

const COLUMNS: Column[] = [
  { label: 'ФИО', width: 123, value: (row) => row.fullName },
  { label: 'Должность', width: 93, value: (row) => row.position ?? '—' },
  { label: 'Компания', width: 98, value: (row) => row.organization ?? '—' },
  { label: 'Курс', width: 123, value: (row) => row.courseTitle },
  { label: 'Результат', width: 65, value: (row) => `${row.score} / ${row.total}` },
  {
    label: 'Прохождение',
    width: 82,
    value: (row) => row.completedAt.toLocaleDateString('ru-RU'),
  },
  { label: 'Выдача', width: 76, value: (row) => row.issuedAt.toLocaleDateString('ru-RU') },
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
  options: { size?: number; color?: ReturnType<typeof rgb> } = {},
) {
  const size = options.size ?? 8;
  page.drawText(fitText(font, value, size, width - 12), {
    x: x + 6,
    y: y + (ROW_HEIGHT - size) / 2 - 1,
    size,
    font,
    color: options.color ?? INK,
  });
}

function drawReportHeader(page: PDFPage, font: PDFFont, createdAt: Date, rowCount: number) {
  const { width, height } = page.getSize();
  page.drawRectangle({ x: 0, y: height - 88, width, height: 88, color: GREEN_DARK });
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
  const metadata = `${createdAt.toLocaleDateString('ru-RU')} · участников: ${rowCount}`;
  page.drawText(metadata, {
    x: width - MARGIN - font.widthOfTextAtSize(metadata, 9),
    y: height - 48,
    size: 9,
    font,
    color: rgb(0.85, 0.96, 0.87),
  });
}

function drawTableHeader(page: PDFPage, font: PDFFont, y: number) {
  let x = MARGIN;
  page.drawRectangle({
    x: MARGIN,
    y,
    width: A4_LANDSCAPE[0] - MARGIN * 2,
    height: HEADER_HEIGHT,
    color: GREEN,
  });
  for (const column of COLUMNS) {
    page.drawText(fitText(font, column.label, 8, column.width - 12), {
      x: x + 6,
      y: y + 19,
      size: 8,
      font,
      color: rgb(1, 1, 1),
    });
    x += column.width;
  }
}

function drawReportFooter(page: PDFPage, font: PDFFont, pageNumber: number, pageCount: number) {
  const { width } = page.getSize();
  const footer = `Страница ${pageNumber} из ${pageCount}`;
  page.drawText(footer, {
    x: width - MARGIN - font.widthOfTextAtSize(footer, 8),
    y: 16,
    size: 8,
    font,
    color: MUTED,
  });
  page.drawText('Сформировано SafetyHub.kz', {
    x: MARGIN,
    y: 16,
    size: 8,
    font,
    color: MUTED,
  });
}

export async function generateCertificateReport(
  sourceRows: readonly CertificateReportRow[],
  createdAt = new Date(),
): Promise<Uint8Array> {
  if (sourceRows.length > 100) {
    throw new Error('CERTIFICATE_REPORT_SIZE_INVALID');
  }
  const rows = sourceRows.map((row) => ({
    ...row,
    fullName: normalizePdfText(row.fullName),
    position: row.position ? normalizePdfText(row.position) : null,
    organization: row.organization ? normalizePdfText(row.organization) : null,
    courseTitle: normalizePdfText(row.courseTitle),
    certificateNumber: normalizePdfText(row.certificateNumber),
  }));
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  // The prepared asset already contains only Latin/Cyrillic/Kazakh glyphs.
  // Runtime subsetting stays off to preserve portable text extraction.
  const font = await pdf.embedFont(await REPORT_FONT_BYTES, { subset: false });
  pdf.setTitle('Отчёт по выданным сертификатам SafetyHub.kz');
  pdf.setSubject('Сводный отчёт об аттестации');
  pdf.setAuthor('SafetyHub.kz');
  pdf.setCreator('SafetyHub.kz');
  pdf.setProducer('SafetyHub.kz');
  pdf.setCreationDate(createdAt);
  pdf.setModificationDate(createdAt);

  const tableTop = A4_LANDSCAPE[1] - 112;
  const tableBottom = FOOTER_HEIGHT + 12;
  const rowsPerPage = Math.max(
    1,
    Math.floor((tableTop - tableBottom - HEADER_HEIGHT) / ROW_HEIGHT),
  );
  const pageCount = Math.max(1, Math.ceil(rows.length / rowsPerPage));

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const page = pdf.addPage(A4_LANDSCAPE);
    drawReportHeader(page, font, createdAt, rows.length);
    drawTableHeader(page, font, tableTop - HEADER_HEIGHT);
    const pageRows = rows.slice(pageIndex * rowsPerPage, (pageIndex + 1) * rowsPerPage);
    if (pageRows.length === 0) {
      page.drawText('Действующих сертификатов в выбранных строках нет.', {
        x: MARGIN,
        y: tableTop - HEADER_HEIGHT - ROW_HEIGHT,
        size: 10,
        font,
        color: MUTED,
      });
    }
    pageRows.forEach((row, index) => {
      const y = tableTop - HEADER_HEIGHT - (index + 1) * ROW_HEIGHT;
      page.drawRectangle({
        x: MARGIN,
        y,
        width: A4_LANDSCAPE[0] - MARGIN * 2,
        height: ROW_HEIGHT,
        color: index % 2 === 0 ? rgb(1, 1, 1) : GREEN_PALE,
        borderColor: BORDER,
        borderWidth: 0.35,
      });
      let x = MARGIN;
      for (const column of COLUMNS) {
        drawCell(page, font, column.value(row), x, y, column.width);
        x += column.width;
      }
    });
    drawReportFooter(page, font, pageIndex + 1, pageCount);
  }

  return pdf.save({ useObjectStreams: true });
}
