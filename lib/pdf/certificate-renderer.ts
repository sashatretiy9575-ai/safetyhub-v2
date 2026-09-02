import type { PDFFont, PDFPage, RGB } from 'pdf-lib';
import {
  assertCertificateRenderMetadata,
  type CertificateLocale,
  type CertificateRenderMetadata,
} from './certificate-client-contract.ts';
import { normalizePdfText } from './certificate.ts';

const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024;
const MAX_FONT_BYTES = 24 * 1024 * 1024;

type Labels = Readonly<{
  documentTitle: string;
  documentSubject: string;
  heading: string;
  completion: string;
  position: string;
  organization: string;
  result: (score: number, total: number) => string;
  passScore: (score: number, total: number) => string;
  certificateNumber: (value: string) => string;
  issuedAt: (value: string) => string;
  verify: string;
  dateLocale: string;
}>;

const LABELS: Record<CertificateLocale, Labels> = {
  ru: {
    documentTitle: 'Сертификат',
    documentSubject: 'Проверяемый сертификат SafetyHub.kz',
    heading: 'СЕРТИФИКАТ',
    completion: 'подтверждает успешное прохождение курса',
    position: 'Должность',
    organization: 'Компания',
    result: (score, total) => `Результат: ${score} из ${total}`,
    passScore: (score, total) => `Проходной балл: ${score} из ${total}`,
    certificateNumber: (value) => `Сертификат № ${value}`,
    issuedAt: (value) => `Дата выдачи: ${value}`,
    verify: 'Проверить подлинность',
    dateLocale: 'ru-KZ',
  },
  kk: {
    documentTitle: 'Сертификат',
    documentSubject: 'SafetyHub.kz тексерілетін сертификаты',
    heading: 'СЕРТИФИКАТ',
    completion: 'курсты сәтті аяқтағанын растайды',
    position: 'Лауазымы',
    organization: 'Ұйым',
    result: (score, total) => `Нәтиже: ${score} / ${total}`,
    passScore: (score, total) => `Өту балы: ${score} / ${total}`,
    certificateNumber: (value) => `Сертификат № ${value}`,
    issuedAt: (value) => `Берілген күні: ${value}`,
    verify: 'Түпнұсқалығын тексеру',
    dateLocale: 'kk-KZ',
  },
  en: {
    documentTitle: 'Certificate',
    documentSubject: 'Verifiable SafetyHub.kz certificate',
    heading: 'CERTIFICATE',
    completion: 'confirms successful completion of the course',
    position: 'Position',
    organization: 'Organization',
    result: (score, total) => `Result: ${score} of ${total}`,
    passScore: (score, total) => `Passing score: ${score} of ${total}`,
    certificateNumber: (value) => `Certificate No. ${value}`,
    issuedAt: (value) => `Issued: ${value}`,
    verify: 'Verify authenticity',
    dateLocale: 'en',
  },
  zh: {
    documentTitle: '证书',
    documentSubject: 'SafetyHub.kz 可验证证书',
    heading: '证书',
    completion: '兹证明已成功完成课程',
    position: '职位',
    organization: '单位',
    result: (score, total) => `成绩：${score} / ${total}`,
    passScore: (score, total) => `及格分数：${score} / ${total}`,
    certificateNumber: (value) => `证书编号：${value}`,
    issuedAt: (value) => `签发日期：${value}`,
    verify: '验证真伪',
    dateLocale: 'zh-CN',
  },
};

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

function fittedTextSize(font: PDFFont, text: string, size: number, maxWidth: number, minSize = 8) {
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
  if (!text.includes(' ')) return breakWideToken(font, text, size, maxWidth);
  const words = text.split(' ').flatMap((word) =>
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

function fittedLines(
  font: PDFFont,
  text: string,
  preferredSize: number,
  maxWidth: number,
  maxLines: number,
  minSize = 8,
) {
  for (let size = preferredSize; size >= minSize; size -= 0.5) {
    const lines = wrapLine(font, text, size, maxWidth);
    if (
      lines.length <= maxLines &&
      lines.every((line) => font.widthOfTextAtSize(line, size) <= maxWidth)
    ) {
      return { lines, size };
    }
  }
  throw new Error('CERTIFICATE_TEXT_DOES_NOT_FIT');
}

function drawCenteredText(
  page: PDFPage,
  font: PDFFont,
  text: string,
  options: {
    y: number;
    size: number;
    maxWidth?: number;
    maxLines?: 1 | 2;
    minSize?: number;
    color?: RGB;
  },
  fallbackColor: RGB,
) {
  const { width } = page.getSize();
  const maxWidth = options.maxWidth ?? width - 72;
  const maxLines = options.maxLines ?? 1;
  const { lines, size } =
    maxLines === 1
      ? { lines: [text], size: fittedTextSize(font, text, options.size, maxWidth, options.minSize) }
      : fittedLines(font, text, options.size, maxWidth, maxLines, options.minSize);
  const lineHeight = size * 1.2;
  const firstY = options.y + ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, index) => {
    const textWidth = font.widthOfTextAtSize(line, size);
    page.drawText(line, {
      x: (width - textWidth) / 2,
      y: firstY - index * lineHeight,
      size,
      font,
      color: options.color ?? fallbackColor,
    });
  });
}

function pngBytesFromDataUrl(dataUrl: string) {
  const encoded = dataUrl.split(',', 2)[1];
  if (!encoded) throw new Error('CERTIFICATE_QR_INVALID');
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function generateCertificateInBrowser(
  metadata: CertificateRenderMetadata,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  assertCertificateRenderMetadata(metadata);
  if (signal?.aborted) throw abortError();
  const resolvedTemplateUrl = resolveAssetUrl(metadata.templateUrl, metadata.verificationUrl);
  const resolvedFontUrl = resolveAssetUrl(metadata.fontUrl, metadata.verificationUrl);
  const [{ PDFDocument, rgb }, fontkitModule, qrCodeModule, templateBytes, fontBytes] =
    await Promise.all([
      import('pdf-lib'),
      import('@pdf-lib/fontkit'),
      import('qrcode'),
      fetchBoundedAsset(resolvedTemplateUrl, MAX_TEMPLATE_BYTES, signal),
      loadCertificateFontBytes(resolvedFontUrl, signal),
    ]);
  if (signal?.aborted) throw abortError();
  const fontkit = fontkitModule.default;
  const QRCode = qrCodeModule.default;
  const labels = LABELS[metadata.locale];
  const issuedAt = new Date(metadata.issuedAt);
  const normalized = {
    ...metadata,
    fullName: normalizePdfText(metadata.fullName),
    position: metadata.position ? normalizePdfText(metadata.position) : null,
    organization: metadata.organization ? normalizePdfText(metadata.organization) : null,
    certificateNumber: normalizePdfText(metadata.certificateNumber),
    titleSnapshot: normalizePdfText(metadata.titleSnapshot),
  };
  const qrCodeBytes = pngBytesFromDataUrl(
    await QRCode.toDataURL(metadata.verificationUrl, {
      type: 'image/png',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 256,
      color: { dark: '#0F172AFF', light: '#FFFFFFFF' },
    }),
  );
  if (signal?.aborted) throw abortError();

  const pdfDoc = await PDFDocument.load(templateBytes);
  pdfDoc.setTitle(`${labels.documentTitle} ${normalized.certificateNumber}`);
  pdfDoc.setSubject(labels.documentSubject);
  pdfDoc.setAuthor('SafetyHub.kz');
  pdfDoc.setCreator('SafetyHub.kz');
  pdfDoc.setProducer('SafetyHub.kz');
  pdfDoc.setCreationDate(issuedAt);
  pdfDoc.setModificationDate(issuedAt);
  pdfDoc.registerFontkit(fontkit);
  const font = await pdfDoc.embedFont(fontBytes, { subset: metadata.locale === 'zh' });
  const qrCode = await pdfDoc.embedPng(qrCodeBytes);
  const page = pdfDoc.getPages()[0];
  if (!page) throw new Error('EMPTY_CERTIFICATE_TEMPLATE');
  const { width } = page.getSize();
  const ink = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.35, 0.4, 0.47);
  const green = rgb(0.07, 0.49, 0.16);

  drawCenteredText(page, font, labels.heading, { y: 694, size: 28, color: green }, ink);
  drawCenteredText(page, font, labels.completion, { y: 654, size: 12, color: muted }, ink);
  drawCenteredText(
    page,
    font,
    normalized.titleSnapshot,
    { y: 486, size: 21, maxWidth: width - 96, maxLines: 2, minSize: 12 },
    ink,
  );
  drawCenteredText(
    page,
    font,
    normalized.fullName,
    { y: 414, size: 31, maxWidth: width - 88, maxLines: 2, minSize: 16, color: green },
    ink,
  );
  if (normalized.position) {
    drawCenteredText(
      page,
      font,
      `${labels.position}: ${normalized.position}`,
      { y: 350, size: 13, maxWidth: width - 100, maxLines: 2, minSize: 9 },
      ink,
    );
  }
  if (normalized.organization) {
    drawCenteredText(
      page,
      font,
      `${labels.organization}: ${normalized.organization}`,
      { y: 310, size: 13, maxWidth: width - 100, maxLines: 2, minSize: 9 },
      ink,
    );
  }
  drawCenteredText(
    page,
    font,
    labels.result(normalized.score, normalized.total),
    { y: 244, size: 18, color: green },
    ink,
  );
  drawCenteredText(
    page,
    font,
    labels.passScore(normalized.passScore, normalized.total),
    { y: 216, size: 10, color: muted },
    ink,
  );

  const certificateLabel = labels.certificateNumber(normalized.certificateNumber);
  page.drawText(certificateLabel, {
    x: 64,
    y: 151,
    size: fittedTextSize(font, certificateLabel, 11, width - 220),
    font,
    color: ink,
  });
  const dateValue = new Intl.DateTimeFormat(labels.dateLocale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Oral',
  }).format(issuedAt);
  page.drawText(labels.issuedAt(dateValue), { x: 64, y: 126, size: 10, font, color: muted });

  const qrSize = 74;
  const qrX = width - qrSize - 64;
  const qrY = 90;
  const qrLabelSize = fittedTextSize(font, labels.verify, 7, qrSize, 5);
  page.drawRectangle({
    x: qrX - 7,
    y: qrY - 7,
    width: qrSize + 14,
    height: qrSize + 28,
    color: rgb(1, 1, 1),
    borderColor: rgb(0.79, 0.84, 0.8),
    borderWidth: 0.7,
  });
  page.drawImage(qrCode, { x: qrX, y: qrY, width: qrSize, height: qrSize });
  page.drawText(labels.verify, {
    x: qrX + (qrSize - font.widthOfTextAtSize(labels.verify, qrLabelSize)) / 2,
    y: qrY + qrSize + 7,
    size: qrLabelSize,
    font,
    color: muted,
  });
  if (signal?.aborted) throw abortError();
  return pdfDoc.save({ useObjectStreams: true });
}
