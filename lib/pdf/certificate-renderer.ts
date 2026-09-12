import type { PDFDocument as PDFDocumentType, PDFFont, PDFImage, PDFPage, RGB } from 'pdf-lib';
import {
  assertCertificateRenderMetadata,
  type CertificateBranding,
  type CertificateRenderMetadata,
} from './certificate-client-contract.ts';
import { normalizePdfText } from './certificate.ts';

// The largest font this can be asked for is the Simplified Chinese subset
// at 3.5 MB. The ceiling was 24 MB, chosen to let the unsubsetted 16.4 MB
// original through; there is nothing left that needs the room.
const MAX_FONT_BYTES = 6 * 1024 * 1024;
// A stamp or signature PNG the administrator uploaded; the settings route
// refuses anything above 400 KB, this only guards the transport.
const MAX_IMAGE_BYTES = 600 * 1024;

/**
 * The certificate is a two-sided booklet ("корочка"): page one is its left
 * side, page two the right, each A5 landscape so both print on one A4 sheet.
 * The labels are the fixed bilingual Kazakh/Russian form of the paper
 * original; the interface locale only chooses the font, so a Chinese name is
 * drawn with the CJK face.
 */
const PAGE: [number, number] = [595.28, 419.53];
const BORDER_INSET = 14;
const MARGIN = 40;

const assetCache = new Map<string, Promise<Uint8Array>>();

function abortError() {
  return new DOMException('Certificate generation was cancelled', 'AbortError');
}

async function fetchBoundedAsset(
  url: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (signal?.aborted) throw abortError();
  const existing = assetCache.get(url);
  if (existing) return existing;
  const pending = (async () => {
    const response = await fetch(url, {
      credentials: 'same-origin',
      cache: 'force-cache',
      signal,
    });
    if (!response.ok) throw new Error('CERTIFICATE_ASSET_UNAVAILABLE');
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      throw new Error('CERTIFICATE_ASSET_TOO_LARGE');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
      throw new Error('CERTIFICATE_ASSET_TOO_LARGE');
    }
    return bytes;
  })();
  assetCache.set(url, pending);
  try {
    return await pending;
  } catch (error) {
    assetCache.delete(url);
    throw error;
  }
}

export function resolveAssetUrl(url: string, verificationUrl?: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  // Preserve relative URLs in Node.js runtime/tests
  if (typeof window === 'undefined' && typeof self === 'undefined') return url;

  // 1. If verificationUrl is provided, resolve against its origin
  if (verificationUrl) {
    try {
      return new URL(url, new URL(verificationUrl).origin).href;
    } catch {
      // ignore
    }
  }

  // 2. In browser window, resolve against window.location.origin
  if (typeof window !== 'undefined' && window.location?.origin) {
    try {
      return new URL(url, window.location.origin).href;
    } catch {
      // ignore
    }
  }

  // 3. In web worker, resolve against self.location.origin if valid
  if (typeof self !== 'undefined' && self.location?.origin) {
    const origin = self.location.origin;
    if (!origin.startsWith('blob:') && origin !== 'null') {
      try {
        return new URL(url, origin).href;
      } catch {
        // ignore
      }
    }
  }

  return url;
}

export function loadCertificateFontBytes(url: string, signal?: AbortSignal) {
  return fetchBoundedAsset(url, MAX_FONT_BYTES, signal);
}

/** A stamp or signature PNG; the protocol renderer shares it and its cache. */
export function loadCertificateImageBytes(url: string, signal?: AbortSignal) {
  return fetchBoundedAsset(url, MAX_IMAGE_BYTES, signal);
}

function fittedTextSize(font: PDFFont, text: string, size: number, maxWidth: number, minSize = 6) {
  const naturalWidth = font.widthOfTextAtSize(text, size);
  if (naturalWidth <= maxWidth) return size;
  return Math.max(minSize, size * (maxWidth / naturalWidth));
}

function breakWideToken(font: PDFFont, token: string, size: number, maxWidth: number) {
  const chunks: string[] = [];
  let chunk = '';
  for (const point of Array.from(token)) {
    const candidate = `${chunk}${point}`;
    if (chunk && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      chunks.push(chunk);
      chunk = point;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function wrapLine(font: PDFFont, text: string, size: number, maxWidth: number) {
  if (!text) return [];
  if (!text.includes(' ')) return breakWideToken(font, text, size, maxWidth);
  const words = text
    .split(' ')
    .flatMap((word) =>
      font.widthOfTextAtSize(word, size) <= maxWidth
        ? [word]
        : breakWideToken(font, word, size, maxWidth),
    );
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  return lines;
}

/** Wraps at the preferred size and shrinks until the text fits the line budget. */
function fittedLines(
  font: PDFFont,
  text: string,
  preferredSize: number,
  maxWidth: number,
  maxLines: number,
  minSize = 6,
) {
  for (let size = preferredSize; size >= minSize; size -= 0.5) {
    const lines = wrapLine(font, text, size, maxWidth);
    if (lines.length <= maxLines) return { lines, size };
  }
  const lines = wrapLine(font, text, minSize, maxWidth).slice(0, maxLines);
  return { lines, size: minSize };
}

type Pen = Readonly<{
  page: PDFPage;
  font: PDFFont;
  ink: RGB;
  muted: RGB;
  rule: RGB;
  white: RGB;
}>;

/** A label followed by a value on a ruled line, like the paper form. */
function drawField(
  pen: Pen,
  label: string,
  value: string,
  x: number,
  y: number,
  lineEnd: number,
  size = 10,
) {
  const { page, font, ink, rule } = pen;
  page.drawText(label, { x, y, size, font, color: ink });
  const labelWidth = font.widthOfTextAtSize(label, size) + 4;
  const valueX = x + labelWidth;
  const maxWidth = lineEnd - valueX - 2;
  if (value && maxWidth > 20) {
    const fitted = fittedTextSize(font, value, size, maxWidth, 6);
    page.drawText(value, { x: valueX + 2, y, size: fitted, font, color: ink });
  }
  page.drawLine({
    start: { x: valueX, y: y - 2.5 },
    end: { x: lineEnd, y: y - 2.5 },
    thickness: 0.6,
    color: rule,
  });
}

function drawParagraph(
  pen: Pen,
  text: string,
  x: number,
  top: number,
  maxWidth: number,
  maxLines: number,
  size = 9,
) {
  const { page, font, ink } = pen;
  const { lines, size: fitted } = fittedLines(font, text, size, maxWidth, maxLines, 6.5);
  const lineHeight = fitted * 1.25;
  lines.forEach((line, index) => {
    page.drawText(line, { x, y: top - index * lineHeight, size: fitted, font, color: ink });
  });
  return top - lines.length * lineHeight;
}

function drawCentered(pen: Pen, text: string, y: number, size: number, color = pen.ink) {
  const { page, font } = pen;
  const { width } = page.getSize();
  const fitted = fittedTextSize(font, text, size, width - 2 * MARGIN, 7);
  page.drawText(text, {
    x: (width - font.widthOfTextAtSize(text, fitted)) / 2,
    y,
    size: fitted,
    font,
    color,
  });
}

function drawBorder(page: PDFPage, rule: RGB) {
  const { width, height } = page.getSize();
  page.drawRectangle({
    x: BORDER_INSET,
    y: BORDER_INSET,
    width: width - 2 * BORDER_INSET,
    height: height - 2 * BORDER_INSET,
    borderColor: rule,
    borderWidth: 0.9,
  });
}

/** Fits an image inside a box, keeping its proportions, bottom-left anchored. */
function drawImageInBox(
  page: PDFPage,
  image: PDFImage | null,
  x: number,
  y: number,
  boxWidth: number,
  boxHeight: number,
) {
  if (!image) return;
  const scale = Math.min(boxWidth / image.width, boxHeight / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  page.drawImage(image, { x, y, width, height });
}

const RU_MONTHS_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

function partsInAlmaty(date: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Oral',
  }).formatToParts(date);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { day: pick('day'), month: pick('month'), year: pick('year') };
}

/** «12» сентября 2026 г. — the form's quoted-day style. */
export function formatIssueDate(date: Date) {
  const { day, month, year } = partsInAlmaty(date);
  return `«${String(day).padStart(2, '0')}» ${RU_MONTHS_GENITIVE[month - 1]} ${year} г.`;
}

/** dd.mm.yyyy, or null when the settings give no validity period. */
export function certificateValidUntil(issuedAt: Date, validityMonths: number): Date | null {
  if (!Number.isInteger(validityMonths) || validityMonths <= 0) return null;
  const until = new Date(issuedAt.getTime());
  until.setUTCMonth(until.getUTCMonth() + validityMonths);
  return until;
}

function formatShortDate(date: Date) {
  const { day, month, year } = partsInAlmaty(date);
  return `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${year}`;
}

function statement(template: string, protocolNumber: string) {
  const protocol = protocolNumber || '______';
  return normalizePdfText(template.replaceAll('{protocol}', protocol));
}

type Assets = Readonly<{
  stamp: PDFImage | null;
  chairmanSignature: PDFImage | null;
  memberSignature: PDFImage | null;
}>;

async function embedOptionalPng(
  pdf: PDFDocumentType,
  url: string | null,
  verificationUrl: string,
  signal?: AbortSignal,
) {
  if (!url) return null;
  const bytes = await loadCertificateImageBytes(resolveAssetUrl(url, verificationUrl), signal);
  return pdf.embedPng(bytes);
}

function drawLeftSide(
  pen: Pen,
  metadata: CertificateRenderMetadata,
  branding: CertificateBranding,
  assets: Assets,
  issuedAt: Date,
) {
  const { page, font, ink, muted, rule } = pen;
  const { width } = page.getSize();
  drawBorder(page, rule);

  drawCentered(pen, `КУӘЛІК / УДОСТОВЕРЕНИЕ № ${metadata.certificateNumber}`, 372, 14);

  // The photo box on the right, as on the paper form: the photograph is
  // glued in by hand, so the box stays empty.
  const photo = { x: width - MARGIN - 150, y: 58, width: 150, height: 232 };
  page.drawRectangle({
    ...photo,
    borderColor: rule,
    borderWidth: 0.8,
  });

  const lineEnd = width - MARGIN;
  const narrowEnd = photo.x - 14;
  drawField(pen, 'Берілді/Выдано:', metadata.fullName, MARGIN, 338, lineEnd);
  drawField(pen, 'Лауазымы/Должность:', metadata.position ?? '', MARGIN, 316, lineEnd);
  const organization = metadata.organization ?? '';
  const orgLabel = 'Жұмыс орны/Место работы:';
  const orgLabelWidth = font.widthOfTextAtSize(orgLabel, 10) + 6;
  const orgLines = fittedLines(font, organization, 10, narrowEnd - MARGIN - orgLabelWidth, 1, 7);
  const orgFirst = orgLines.lines.length > 0 && orgLines.size >= 8 ? organization : '';
  drawField(pen, orgLabel, orgFirst, MARGIN, 294, narrowEnd);
  if (!orgFirst && organization) {
    // A long company name moves onto the second ruled line instead of
    // shrinking below legibility.
    const second = fittedLines(font, organization, 10, narrowEnd - MARGIN - 4, 1, 7);
    page.drawText(second.lines[0] ?? '', {
      x: MARGIN + 2,
      y: 272,
      size: second.size,
      font,
      color: ink,
    });
  }
  page.drawLine({
    start: { x: MARGIN, y: 269.5 },
    end: { x: narrowEnd, y: 269.5 },
    thickness: 0.6,
    color: rule,
  });

  let cursor = 246;
  cursor = drawParagraph(
    pen,
    statement(branding.examTextKk, branding.protocolNumber),
    MARGIN,
    cursor,
    narrowEnd - MARGIN,
    4,
  );
  cursor -= 6;
  cursor = drawParagraph(
    pen,
    statement(branding.examTextRu, branding.protocolNumber),
    MARGIN,
    cursor,
    narrowEnd - MARGIN,
    4,
  );

  const dateY = Math.min(cursor - 16, 128);
  page.drawText(`Берілген күні/Дата выдачи ${formatIssueDate(issuedAt)}`, {
    x: MARGIN,
    y: dateY,
    size: 10,
    font,
    color: ink,
  });

  // The stamp sits to the right of the seal marks, between them and the
  // photo box, so it never covers the organization or the BIN.
  const stampBox = { x: narrowEnd - 84, y: 40, width: 84, height: 84 };
  drawImageInBox(page, assets.stamp, stampBox.x, stampBox.y, stampBox.width, stampBox.height);

  const sealEnd = narrowEnd - 124;
  drawField(pen, 'ЖШС / ТОО', branding.organizationName, MARGIN, 84, sealEnd);
  page.drawText('М.О.', { x: sealEnd + 8, y: 84, size: 10, font, color: ink });
  drawField(pen, 'БСН / БИН', branding.bin, MARGIN, 60, sealEnd);
  page.drawText('М.П.', { x: sealEnd + 8, y: 60, size: 10, font, color: ink });

  void muted;
}

function drawSignatureRow(
  pen: Pen,
  image: PDFImage | null,
  name: string,
  caption: string,
  lineY: number,
) {
  const { page, font, ink, muted, rule } = pen;
  const { width } = page.getSize();
  const lineStart = MARGIN;
  const lineEnd = width - MARGIN;
  drawImageInBox(page, image, lineStart + 24, lineY + 2, 120, 40);
  if (name) {
    const size = fittedTextSize(font, name, 9.5, lineEnd - lineStart - 190, 7);
    page.drawText(name, {
      x: lineEnd - font.widthOfTextAtSize(name, size),
      y: lineY + 4,
      size,
      font,
      color: ink,
    });
  }
  page.drawLine({
    start: { x: lineStart, y: lineY },
    end: { x: lineEnd, y: lineY },
    thickness: 0.6,
    color: rule,
  });
  const captionSize = fittedTextSize(font, caption, 6.5, lineEnd - lineStart, 5);
  page.drawText(caption, {
    x: (width - font.widthOfTextAtSize(caption, captionSize)) / 2,
    y: lineY - 9,
    size: captionSize,
    font,
    color: muted,
  });
}

function drawRightSide(
  pen: Pen,
  metadata: CertificateRenderMetadata,
  branding: CertificateBranding,
  assets: Assets,
  issuedAt: Date,
  qrMatrix: { modules: { size: number; data: Uint8Array | number[] } },
) {
  const { page, font, ink, muted, rule, white } = pen;
  const { width } = page.getSize();
  drawBorder(page, rule);

  drawCentered(pen, 'Білімін тексеру туралы мәліметтер', 378, 12);
  drawCentered(pen, 'Сведения о проверке знаний', 362, 12);

  const lineEnd = width - MARGIN;
  // The QR block sits in the top-right corner; the first ruled line stops
  // short of it.
  const qrSize = 44;
  const qrX = width - MARGIN - qrSize;
  const qrY = 336;
  drawField(pen, 'Жұмыс орны/Место работы:', metadata.organization ?? '', MARGIN, 322, qrX - 16);
  page.drawLine({
    start: { x: MARGIN, y: 298 },
    end: { x: lineEnd, y: 298 },
    thickness: 0.6,
    color: rule,
  });

  let cursor = 280;
  cursor = drawParagraph(
    pen,
    statement(branding.knowledgeTextKk, branding.protocolNumber),
    MARGIN,
    cursor,
    lineEnd - MARGIN,
    3,
    9.5,
  );
  cursor -= 8;
  cursor = drawParagraph(
    pen,
    statement(branding.knowledgeTextRu, branding.protocolNumber),
    MARGIN,
    cursor,
    lineEnd - MARGIN,
    3,
    9.5,
  );

  const validUntil = certificateValidUntil(issuedAt, branding.validityMonths);
  const dateY = Math.min(cursor - 18, 176);
  const issued = `Берілген күні/Дата выдачи ${formatIssueDate(issuedAt)}`;
  page.drawText(issued, { x: MARGIN, y: dateY, size: 9.5, font, color: ink });
  const validity = `Действителен до ${validUntil ? formatShortDate(validUntil) : '____________'} дейін жарамды`;
  page.drawText(validity, {
    x: MARGIN,
    y: dateY - 15,
    size: 9.5,
    font,
    color: ink,
  });

  drawSignatureRow(
    pen,
    assets.chairmanSignature,
    branding.chairmanName,
    'Емтихан комиссиясының төрағасы (Т.А.Ә.) / Председатель экзаменационной комиссии (Ф.И.О.)',
    106,
  );
  drawSignatureRow(
    pen,
    assets.memberSignature,
    branding.memberName,
    'Емтихан комиссиясының мүшесі (Т.А.Ә.) / Член экзаменационной комиссии (Ф.И.О.)',
    56,
  );

  // The verification QR keeps its place: a scan still proves the certificate.
  page.drawRectangle({
    x: qrX - 3,
    y: qrY - 3,
    width: qrSize + 6,
    height: qrSize + 6,
    color: white,
    borderColor: rule,
    borderWidth: 0.5,
  });
  const qrModules = qrMatrix.modules.size;
  const qrCell = qrSize / (qrModules + 2);
  for (let row = 0; row < qrModules; row += 1) {
    for (let col = 0; col < qrModules; col += 1) {
      if (qrMatrix.modules.data[row * qrModules + col]) {
        page.drawRectangle({
          x: qrX + (col + 1) * qrCell,
          y: qrY + qrSize - (row + 2) * qrCell,
          width: qrCell,
          height: qrCell,
          color: ink,
        });
      }
    }
  }
  const verify = 'Тексеру / Проверить';
  const verifySize = fittedTextSize(font, verify, 5.5, qrSize + 10, 4);
  page.drawText(verify, {
    x: qrX + (qrSize - font.widthOfTextAtSize(verify, verifySize)) / 2,
    y: qrY - 11,
    size: verifySize,
    font,
    color: muted,
  });
}

export async function generateCertificateInBrowser(
  metadata: CertificateRenderMetadata,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  assertCertificateRenderMetadata(metadata);
  if (signal?.aborted) throw abortError();
  const resolvedFontUrl = resolveAssetUrl(metadata.fontUrl, metadata.verificationUrl);
  const [{ PDFDocument, rgb }, fontkitModule, qrCodeModule, fontBytes] = await Promise.all([
    import('pdf-lib'),
    import('@pdf-lib/fontkit'),
    import('qrcode'),
    loadCertificateFontBytes(resolvedFontUrl, signal),
  ]);
  if (signal?.aborted) throw abortError();
  const fontkit = fontkitModule.default;
  const QRCode = qrCodeModule.default;
  const issuedAt = new Date(metadata.issuedAt);
  const normalized: CertificateRenderMetadata = {
    ...metadata,
    fullName: normalizePdfText(metadata.fullName),
    position: metadata.position ? normalizePdfText(metadata.position) : null,
    organization: metadata.organization ? normalizePdfText(metadata.organization) : null,
    certificateNumber: normalizePdfText(metadata.certificateNumber),
    titleSnapshot: normalizePdfText(metadata.titleSnapshot),
  };
  const branding: CertificateBranding = {
    ...metadata.branding,
    organizationName: normalizePdfText(metadata.branding.organizationName),
    bin: normalizePdfText(metadata.branding.bin),
    chairmanName: normalizePdfText(metadata.branding.chairmanName),
    memberName: normalizePdfText(metadata.branding.memberName),
    protocolNumber: normalizePdfText(metadata.branding.protocolNumber),
  };
  const qrMatrix = (
    QRCode as unknown as {
      create: (
        text: string,
        options?: unknown,
      ) => { modules: { size: number; data: Uint8Array | number[] } };
    }
  ).create(metadata.verificationUrl, { errorCorrectionLevel: 'M' });
  if (signal?.aborted) throw abortError();

  const pdf = await PDFDocument.create();
  pdf.setTitle(`Удостоверение ${normalized.certificateNumber}`);
  pdf.setSubject('Удостоверение о проверке знаний SafetyHub.kz');
  pdf.setAuthor('SafetyHub.kz');
  pdf.setCreator('SafetyHub.kz');
  pdf.setProducer('SafetyHub.kz');
  pdf.setCreationDate(issuedAt);
  pdf.setModificationDate(issuedAt);
  pdf.registerFontkit(fontkit);
  // Every face is subset: the booklet uses a few dozen glyphs, and the full
  // Latin/Cyrillic file used to add 100 KB to each of the hundred certificates
  // in an export. Subsetting costs no measurable time (the Chinese face was
  // always subset) and keeps the text selectable through the ToUnicode map.
  const [font, stamp, chairmanSignature, memberSignature] = await Promise.all([
    pdf.embedFont(fontBytes, { subset: true }),
    embedOptionalPng(pdf, branding.stampUrl, metadata.verificationUrl, signal),
    embedOptionalPng(pdf, branding.chairmanSignatureUrl, metadata.verificationUrl, signal),
    embedOptionalPng(pdf, branding.memberSignatureUrl, metadata.verificationUrl, signal),
  ]);
  const assets: Assets = { stamp, chairmanSignature, memberSignature };
  if (signal?.aborted) throw abortError();

  const ink = rgb(0.08, 0.09, 0.11);
  const muted = rgb(0.4, 0.42, 0.46);
  const rule = rgb(0.25, 0.27, 0.3);
  const white = rgb(1, 1, 1);

  const left = pdf.addPage(PAGE);
  drawLeftSide(
    { page: left, font, ink, muted, rule, white },
    normalized,
    branding,
    assets,
    issuedAt,
  );
  const right = pdf.addPage(PAGE);
  drawRightSide(
    { page: right, font, ink, muted, rule, white },
    normalized,
    branding,
    assets,
    issuedAt,
    qrMatrix,
  );

  if (signal?.aborted) throw abortError();
  return pdf.save({ useObjectStreams: true });
}
