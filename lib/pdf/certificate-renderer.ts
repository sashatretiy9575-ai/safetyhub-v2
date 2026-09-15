import type { PDFPage } from 'pdf-lib';
import { documentCommission, documentStatement } from './document-editor.ts';
import { wrapDocumentText } from './protocol-renderer.ts';
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

export async function generateCertificateInBrowser(metadata: CertificateRenderMetadata, signal?: AbortSignal): Promise<Uint8Array> {
  assertCertificateRenderMetadata(metadata);
  if (signal?.aborted) throw abortError();
  const [{ PDFDocument, rgb }, fontkitModule, qrCodeModule, fontBytes] = await Promise.all([
    import('pdf-lib'), import('@pdf-lib/fontkit'), import('qrcode'),
    loadCertificateFontBytes(resolveAssetUrl(metadata.fontUrl, metadata.verificationUrl), signal),
  ]);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkitModule.default);
  const font = await pdf.embedFont(fontBytes, { subset: true });
  const branding = metadata.branding;
  const issuedAt = new Date(metadata.issuedAt);
  const protocolDate = branding.protocolDate ? new Date(branding.protocolDate + 'T12:00:00+05:00') : issuedAt;
  const until = certificateValidUntil(issuedAt, branding.validityMonths);
  const ink = rgb(0.08, 0.09, 0.11);
  const statement = (text: string) => documentStatement(text, branding, metadata.titleSnapshot);
  pdf.setTitle('Удостоверение ' + metadata.certificateNumber);
  pdf.setAuthor(branding.organizationName);
  pdf.setCreationDate(issuedAt);
  const pageText = (page: PDFPage, blocks: { text: string; heading?: boolean }[], top: number, bottom: number) => {
    for (let size = 11; size >= 6; size -= 0.5) {
      const measured = blocks.map(block => {
        const fontSize = block.heading ? size + 2 : size;
        return { ...block, fontSize, lines: wrapDocumentText(font, block.text, fontSize, PAGE[0] - 2 * MARGIN) };
      });
      const totalHeight = measured.reduce((sum, b) => sum + b.lines.length * b.fontSize * 1.3 + 7, 0);
      if (totalHeight > top - bottom) continue;
      let y = top;
      for (const block of measured) {
        for (const line of block.lines) {
          page.drawText(line, { x: block.heading ? (PAGE[0] - font.widthOfTextAtSize(line, block.fontSize)) / 2 : MARGIN,
            y, size: block.fontSize, font, color: ink });
          y -= block.fontSize * 1.3;
        }
        y -= 7;
      }
      return;
    }
    throw new Error('DOCUMENT_TEXT_OVERFLOW');
  };
  const sheet = () => {
    const page = pdf.addPage(PAGE);
    page.drawRectangle({ x: BORDER_INSET, y: BORDER_INSET, width: PAGE[0] - BORDER_INSET * 2,
      height: PAGE[1] - BORDER_INSET * 2, borderWidth: 0.6, borderColor: rgb(0.5, 0.5, 0.5) });
    return page;
  };
  pageText(sheet(), [
    { text: 'КУӘЛІК / УДОСТОВЕРЕНИЕ № ' + metadata.certificateNumber, heading: true },
    { text: 'Берілді / Выдано: ' + metadata.fullName },
    { text: 'Лауазымы / Должность: ' + (metadata.position ?? '') },
    { text: 'Жұмыс орны / Место работы: ' + (metadata.organization ?? '') },
    { text: 'Бағдарлама / Программа: ' + metadata.titleSnapshot },
    { text: statement(branding.examTextKk) },
    { text: statement(branding.examTextRu) },
    { text: 'Берілген күні / Дата выдачи: ' + formatIssueDate(issuedAt) },
    { text: branding.organizationName + (branding.bin ? ' · БИН ' + branding.bin : '') },
  ].filter(b => b.text), 376, 36);
  const right = sheet();
  pageText(right, [
    { text: 'Білімін тексеру туралы мәліметтер', heading: true },
    { text: 'Сведения о проверке знаний', heading: true },
    { text: 'Жұмыс орны / Место работы: ' + (metadata.organization ?? '') },
    { text: 'Программа: ' + metadata.titleSnapshot },
    { text: statement(branding.knowledgeTextKk) },
    { text: statement(branding.knowledgeTextRu) },
    { text: 'Протокол № ' + branding.protocolNumber + ' от ' + formatIssueDate(protocolDate) },
    { text: 'Результат: ' + metadata.score + '/' + metadata.total },
    { text: until ? 'Действителен до: ' + formatIssueDate(until) : 'Без ограничения срока действия' },
    { text: 'Председатель: ' + branding.chairmanName + '. ' + branding.chairmanPosition },
    ...documentCommission(branding).map(m => ({ text: 'Член комиссии: ' + m.name + '. ' + m.position })),
    ...(branding.documentDefaults?.reviewerName ? [{ text: 'Проверяющий: ' + branding.documentDefaults.reviewerName }] : []),
  ].filter(b => b.text), 378, 91);
  const qr = qrCodeModule.default.create(metadata.verificationUrl, { errorCorrectionLevel: 'M' });
  const qrSize = 48;
  const cell = qrSize / (qr.modules.size + 8);
  const qrX = PAGE[0] - MARGIN - qrSize;
  for (let row = 0; row < qr.modules.size; row++) {
    for (let column = 0; column < qr.modules.size; column++) {
      if (qr.modules.data[row * qr.modules.size + column]) right.drawRectangle({
        x: qrX + (column + 4) * cell, y: 32 + qrSize - (row + 5) * cell, width: cell, height: cell, color: ink,
      });
    }
  }
  right.drawText('Проверка удостоверения', { x: MARGIN, y: 48, size: 8, font, color: ink });
  if (signal?.aborted) throw abortError();
  return pdf.save({ useObjectStreams: true });
}
