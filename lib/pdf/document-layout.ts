import type { PDFDocument, PDFFont, PDFPage } from 'pdf-lib';
import { rgb } from 'pdf-lib';
import { loadCertificateFontBytes, resolveAssetUrl } from './certificate-renderer.ts';
import { wrapDocumentText } from './protocol-renderer.ts';

export const ink = rgb(0, 0, 0);
export async function loadDocumentFonts(pdf: PDFDocument, fallbackUrl: string, origin?: string, signal?: AbortSignal) {
  const urls = ['/certificate-assets/font?face=serif&weight=regular&v=1', '/certificate-assets/font?face=serif&weight=bold&v=1', fallbackUrl, '/certificate-assets/font?face=sans&weight=bold&v=1'];
  const fonts = await Promise.all(urls.map(async url => pdf.embedFont(await loadCertificateFontBytes(resolveAssetUrl(url, origin), signal), { subset: true })));
  return { regular: fonts[0]!, bold: fonts[1]!, sans: fonts[2]!, sansBold: fonts[3]!, pick: (text: string, bold = false) => /[\u3400-\u9fff]/u.test(text) ? fonts[2]! : fonts[bold ? 1 : 0]! };
}

/** Coordinates measured from the top of the printable form. Never clips text. */
export function block(page: PDFPage, text: string, font: PDFFont, x: number, top: number, width: number, height: number, size = 12, align: 'left' | 'center' | 'right' = 'left', minSize = 8) {
  for (let s = size; s >= minSize; s -= .25) {
    const lines = text.split(/\r?\n/u).flatMap(line => wrapDocumentText(font, line, s, width));
    if (lines.length * s * 1.2 > height) continue;
    lines.forEach((line, i) => page.drawText(line, { x: x + (align === 'center' ? (width - font.widthOfTextAtSize(line, s)) / 2 : align === 'right' ? width - font.widthOfTextAtSize(line, s) : 0), y: page.getHeight() - top - s - i * s * 1.2, size: s, font, color: ink }));
    return lines.length * s * 1.2;
  }
  throw new Error('DOCUMENT_TEXT_OVERFLOW');
}
export function rule(page: PDFPage, x: number, top: number, width: number, thickness = .5) {
  page.drawLine({ start: { x, y: page.getHeight() - top }, end: { x: x + width, y: page.getHeight() - top }, thickness, color: ink });
}
