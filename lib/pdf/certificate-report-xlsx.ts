import type { CertificateRenderMetadata } from './certificate-client-contract.ts';
import { certificateValidUntil } from './certificate-renderer.ts';
import { normalizePdfText } from './certificate.ts';

/**
 * The list that travels with a company's certificates. It used to be a PDF
 * table; the owner files these in Excel, so it is a workbook now — written
 * by hand as the handful of XML parts a .xlsx is, zipped with fflate, no
 * spreadsheet library.
 */
export type CertificateReportRow = Readonly<{
  fullName: string;
  position: string | null;
  organization: string | null;
  courseTitle: string;
  score: number;
  total: number;
  completedAt: Date;
  issuedAt: Date;
  validUntil: Date | null;
  certificateNumber: string;
}>;

export const CERTIFICATE_REPORT_FILENAME = 'report.xlsx';
const MAX_ROWS = 500;

type Column = Readonly<{
  label: string;
  width: number;
  value: (row: CertificateReportRow, index: number) => string | number;
}>;

function shortDate(date: Date | null) {
  if (!date || Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Oral',
  }).format(date);
}

const COLUMNS: readonly Column[] = [
  { label: '№', width: 5, value: (_row, index) => index + 1 },
  { label: 'ФИО', width: 32, value: (row) => row.fullName },
  { label: 'Должность', width: 24, value: (row) => row.position ?? '' },
  { label: 'Компания', width: 28, value: (row) => row.organization ?? '' },
  { label: 'Курс', width: 34, value: (row) => row.courseTitle },
  { label: 'Результат', width: 11, value: (row) => `${row.score} / ${row.total}` },
  { label: 'Дата прохождения', width: 17, value: (row) => shortDate(row.completedAt) },
  { label: 'Дата выдачи', width: 13, value: (row) => shortDate(row.issuedAt) },
  { label: 'Действителен до', width: 16, value: (row) => shortDate(row.validUntil) },
  { label: '№ удостоверения', width: 24, value: (row) => row.certificateNumber },
];

export function certificateReportRows(
  items: readonly CertificateRenderMetadata[],
): CertificateReportRow[] {
  return items.map((item) => {
    const issuedAt = new Date(item.issuedAt);
    // The booklet and the protocol count the term from the protocol's sitting;
    // the report says the same date, not the moment the file was issued.
    const sitting = item.branding.protocolDate
      ? new Date(`${item.branding.protocolDate}T12:00:00+05:00`)
      : issuedAt;
    return {
      fullName: item.fullName,
      position: item.position,
      organization: item.organization,
      courseTitle: item.titleSnapshot,
      score: item.score,
      total: item.total,
      completedAt: new Date(item.completedAt),
      issuedAt,
      validUntil: certificateValidUntil(sitting, item.branding.validityMonths),
      certificateNumber: item.certificateNumber,
    };
  });
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '');
}

/** A value a spreadsheet would run as a formula is written as text. */
function cellText(value: string) {
  const normalized = normalizePdfText(value);
  return /^[=+\-@]/u.test(normalized) ? `'${normalized}` : normalized;
}

function columnLetter(index: number) {
  let letters = '';
  let cursor = index + 1;
  while (cursor > 0) {
    const remainder = (cursor - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    cursor = Math.floor((cursor - 1) / 26);
  }
  return letters;
}

function cell(column: number, rowNumber: number, value: string | number, style: number) {
  const reference = `${columnLetter(column)}${rowNumber}`;
  if (typeof value === 'number') {
    return `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
  }
  return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cellText(value))}</t></is></c>`;
}

function sheetXml(rows: readonly CertificateReportRow[], createdAt: Date) {
  const lines: string[] = [];
  lines.push(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`,
    '<cols>',
    ...COLUMNS.map(
      (column, index) =>
        `<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"/>`,
    ),
    '</cols>',
    '<sheetData>',
  );
  const title = `Выданные удостоверения · SafetyHub · ${shortDate(createdAt)} · записей: ${rows.length}`;
  lines.push(`<row r="1">${cell(0, 1, title, 2)}</row>`);
  lines.push(
    `<row r="2">${COLUMNS.map((column, index) => cell(index, 2, column.label, 1)).join('')}</row>`,
  );
  rows.forEach((row, rowIndex) => {
    const rowNumber = rowIndex + 3;
    lines.push(
      `<row r="${rowNumber}">${COLUMNS.map((column, index) =>
        cell(index, rowNumber, column.value(row, rowIndex), 0),
      ).join('')}</row>`,
    );
  });
  if (rows.length === 0) {
    lines.push(
      `<row r="3">${cell(0, 3, 'Действующих удостоверений в выбранных строках нет.', 0)}</row>`,
    );
  }
  lines.push('</sheetData>');
  lines.push(
    `<mergeCells count="1"><mergeCell ref="A1:${columnLetter(COLUMNS.length - 1)}1"/></mergeCells>`,
  );
  lines.push('<pageSetup orientation="landscape" paperSize="9" fitToWidth="1" fitToHeight="0"/>');
  lines.push('</worksheet>');
  return lines.join('');
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
  '</Types>';

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
  '</Relationships>';

const WORKBOOK =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<sheets><sheet name="Удостоверения" sheetId="1" r:id="rId1"/></sheets>' +
  '</workbook>';

const WORKBOOK_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>';

// Style 0: body. Style 1: bold header on a light fill with borders. Style 2:
// the bold title row.
const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8F3EA"/></patternFill></fill></fills>' +
  '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFBFC7C2"/></left><right style="thin"><color rgb="FFBFC7C2"/></right><top style="thin"><color rgb="FFBFC7C2"/></top><bottom style="thin"><color rgb="FFBFC7C2"/></bottom><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

function coreXml(createdAt: Date) {
  const stamp = createdAt.toISOString();
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    '<dc:title>Выданные удостоверения SafetyHub</dc:title><dc:creator>SafetyHub</dc:creator>' +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>` +
    '</cp:coreProperties>'
  );
}

const APP_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>SafetyHub</Application></Properties>';

/** Builds the workbook in memory; a few hundred rows are a few hundred KB. */
export async function generateCertificateReportWorkbook(
  sourceRows: readonly CertificateReportRow[],
  createdAt: Date,
): Promise<Uint8Array> {
  if (sourceRows.length > MAX_ROWS) throw new Error('CERTIFICATE_REPORT_SIZE_INVALID');
  const { zipSync, strToU8 } = await import('fflate');
  const rows = sourceRows.map((row) => ({
    ...row,
    fullName: normalizePdfText(row.fullName),
    position: row.position ? normalizePdfText(row.position) : null,
    organization: row.organization ? normalizePdfText(row.organization) : null,
    courseTitle: normalizePdfText(row.courseTitle),
    certificateNumber: normalizePdfText(row.certificateNumber),
  }));
  return zipSync(
    {
      '[Content_Types].xml': strToU8(CONTENT_TYPES),
      '_rels/.rels': strToU8(ROOT_RELS),
      'docProps/core.xml': strToU8(coreXml(createdAt)),
      'docProps/app.xml': strToU8(APP_XML),
      'xl/workbook.xml': strToU8(WORKBOOK),
      'xl/_rels/workbook.xml.rels': strToU8(WORKBOOK_RELS),
      'xl/styles.xml': strToU8(STYLES),
      'xl/worksheets/sheet1.xml': strToU8(sheetXml(rows, createdAt)),
    },
    { level: 6 },
  );
}
