import { block, rule, ink, loadDocumentFonts } from './document-layout.ts';
import { documentCommission, documentStatement } from './document-editor.ts';
import {
  assertCertificateRenderMetadata,
  type CertificateRenderMetadata,
} from './certificate-client-contract.ts';

// The largest font this can be asked for is the Simplified Chinese subset
// at 3.5 MB. The ceiling was 24 MB, chosen to let the unsubsetted 16.4 MB
// original through; there is nothing left that needs the room.
const MAX_FONT_BYTES = 6 * 1024 * 1024;
// A stamp or signature PNG the administrator uploaded; the settings route
// refuses anything above 400 KB, this only guards the transport.
const MAX_IMAGE_BYTES = 600 * 1024;



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
  try {
    const bytes = await pending;
    assetCache.set(url, Promise.resolve(bytes));
    return bytes;
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


export function formatIssueDate(date: Date) {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Oral', day: '2-digit', month: 'long', year: 'numeric' }).format(date);
}
export function certificateValidUntil(issuedAt: Date, validityMonths: number): Date | null {
  if (!Number.isInteger(validityMonths) || validityMonths <= 0) return null;
  const until = new Date(issuedAt);
  const day = until.getUTCDate();
  until.setUTCDate(1);
  until.setUTCMonth(until.getUTCMonth() + validityMonths);
  const last = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth() + 1, 0)).getUTCDate();
  until.setUTCDate(Math.min(day, last));
  return until;
}


export type CertificatePreviewData = Omit<CertificateRenderMetadata, 'certificateId' | 'certificateNumber' | 'verificationUrl'> & {
  certificateId?: string; certificateNumber: string; verificationUrl?: string;
};

export async function generateCertificatePreview(metadata: CertificatePreviewData, signal?: AbortSignal): Promise<Uint8Array> {
  if (signal?.aborted) throw abortError();
  const [{ PDFDocument }, fontkitModule] = await Promise.all([import('pdf-lib'), import('@pdf-lib/fontkit')]);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkitModule.default);
  const fonts = await loadDocumentFonts(pdf, metadata.fontUrl, metadata.verificationUrl, signal);
  const d = metadata.branding.documentDefaults;
  // Uncalibrated preview uses reference proportions, not a guessed paper size.
  const width = d?.insertWidthCm && d?.insertHeightCm ? d.insertWidthCm * 72 / 2.54 : 1200;
  const height = d?.insertWidthCm && d?.insertHeightCm ? d.insertHeightCm * 72 / 2.54 : 375;
  const scale = height / 375, half = width / scale / 2;
  const page = pdf.addPage([half * 2, 375]);
  const branding = metadata.branding, date = new Date(metadata.branding.protocolDate ? metadata.branding.protocolDate + 'T12:00:00+05:00' : metadata.issuedAt);
  const until = certificateValidUntil(date, branding.validityMonths);
  const statement = (text: string) => documentStatement(text, branding, metadata.titleSnapshot);
  const margin = 35, usable = half - margin * 2;
  const txt = (text: string, x: number, y: number, w: number, h: number, size = 12, bold = false, align: 'left' | 'center' | 'right' = 'left') =>
    block(page, text, fonts.pick(text, bold), x, y, w, h, size, align);
  for (const x of [8, half]) page.drawRectangle({ x, y: 8, width: half - 8, height: 359, borderColor: ink, borderWidth: .45 });
  txt('КУӘЛІК / УДОСТОВЕРЕНИЕ № ' + metadata.certificateNumber, margin, 35, usable, 28, 16, true, 'center');
  const field = (label: string, value: string, y: number) => {
    const labelWidth = Math.min(fonts.regular.widthOfTextAtSize(label, 12) + 7, usable * .57);
    txt(label, margin, y, labelWidth - 4, 30);
    txt(value, margin + labelWidth, y, usable - labelWidth, 30);
    rule(page, margin + labelWidth, y + 30, usable - labelWidth);
  };
  field('Берілді/Выдано:', metadata.fullName, 72);
  field('Лауазымы/Должность:', metadata.position ?? '', 102);
  const photoWidth = Math.min(180, usable * .32), photoHeight = 230;
  const photoX = half - margin - photoWidth, bodyWidth = photoX - margin - 17;
  txt('Жұмыс орны/Место работы: ' + (metadata.organization ?? ''), margin, 135, bodyWidth, 46);
  rule(page, margin, 182, bodyWidth);
  txt(statement(branding.examTextKk), margin, 194, bodyWidth, 58);
  txt(statement(branding.examTextRu), margin, 258, bodyWidth, 48);
  txt('Берілген күні/Дата выдачи: ' + formatIssueDate(date), margin, 312, bodyWidth, 27, 11);
  txt(branding.organizationName, margin, 341, bodyWidth - 29, 17, 10);
  txt('БСН / БИН ' + branding.bin, margin, 354, bodyWidth - 29, 13, 10);
  txt('М.О.\nМ.П.', photoX - 32, 341, 30, 24, 10);
  page.drawRectangle({ x: photoX, y: 10, width: photoWidth, height: photoHeight, borderColor: ink, borderWidth: .5 });
  if (metadata.photoUrl) {
    const response = await fetch(resolveAssetUrl(metadata.photoUrl, metadata.verificationUrl), { signal, credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('CERTIFICATE_PHOTO_UNAVAILABLE');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('CERTIFICATE_PHOTO_UNAVAILABLE');
    const photo = await pdf.embedJpg(bytes);
    const fit = Math.min((photoWidth - 2) / photo.width, (photoHeight - 2) / photo.height);
    page.drawImage(photo, { x: photoX + (photoWidth - photo.width * fit) / 2, y: 10 + (photoHeight - photo.height * fit) / 2, width: photo.width * fit, height: photo.height * fit });
  }
  const right = half + margin;
  block(page, 'Білімін тексеру туралы мәліметтер\nСведения о проверке знаний', fonts.sansBold, right, 33, usable, 40, 15, 'center');
  txt('Жұмыс орны/Место работы: ' + (metadata.organization ?? ''), right, 92, usable, 40);
  rule(page, right, 137, usable);
  txt(statement(branding.knowledgeTextKk), right, 151, usable, 46);
  txt(statement(branding.knowledgeTextRu), right, 204, usable, 46);
  txt('Берілген күні/Дата выдачи: ' + formatIssueDate(date), right, 260, usable * .56, 30, 11);
  txt(until ? 'Действителен до: ' + formatIssueDate(until) : 'Без ограничения срока действия', right + usable * .59, 260, usable * .41, 30, 11);
  const members = [{ name: branding.chairmanName, position: 'Төраға / Председатель' }, ...documentCommission(branding).map(m => ({ name: m.name, position: 'Мүшесі / Член комиссии' }))];
  const commissionWidth = usable - (metadata.verificationUrl ? 68 : 0);
  const lineHeight = Math.min(24, 72 / Math.max(members.length, 1));
  if (lineHeight < 10) throw new Error('DOCUMENT_TEXT_OVERFLOW');
  members.forEach((m, i) => {
    const y = 295 + i * lineHeight;
    txt(m.position + ': ' + m.name, right, y, commissionWidth, lineHeight - 3, Math.min(10, lineHeight * .6));
    rule(page, right, y + lineHeight - 1, commissionWidth);
  });
  if (metadata.verificationUrl) {
    const qr = (await import('qrcode')).default.create(metadata.verificationUrl, { errorCorrectionLevel: 'M' });
    const qrSize = 57, cell = qrSize / (qr.modules.size + 8), qrX = half * 2 - margin - qrSize;
    for (let row = 0; row < qr.modules.size; row++) for (let col = 0; col < qr.modules.size; col++) {
      if (qr.modules.data[row * qr.modules.size + col]) page.drawRectangle({ x: qrX + (col + 4) * cell, y: 15 + qrSize - (row + 5) * cell, width: cell, height: cell, color: ink });
    }
  }
  page.scale(scale, scale);
  pdf.setTitle('Удостоверение ' + metadata.certificateNumber);
  pdf.setAuthor(branding.organizationName);
  pdf.setCreationDate(date);
  if (signal?.aborted) throw abortError();
  return pdf.save({ useObjectStreams: true });
}
export async function generateCertificateInBrowser(metadata: CertificateRenderMetadata, signal?: AbortSignal): Promise<Uint8Array> {
  assertCertificateRenderMetadata(metadata);
  if (!metadata.branding.documentDefaults?.insertWidthCm || !metadata.branding.documentDefaults?.insertHeightCm) throw new Error('INSERT_SIZE_REQUIRED');
  return generateCertificatePreview(metadata, signal);
}
