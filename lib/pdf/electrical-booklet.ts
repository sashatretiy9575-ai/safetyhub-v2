import type { PDFDocument, PDFFont, PDFPage } from 'pdf-lib';
import type { CertificatePreviewData } from './certificate-renderer.ts';
import {
  formatIssueDate,
  resolveAssetUrl,
  spanStart,
  measureSpan,
} from './certificate-renderer.ts';
import { block, drawFacsimile, embedFacsimile, ink, rule } from './document-layout.ts';
import { ELECTRICAL_ROLE_TEXT, ELECTRICAL_VOLTAGE_TEXT, personAdmission } from './electrical.ts';

type Fonts = {
  regular: PDFFont;
  bold: PDFFont;
  sansBold: PDFFont;
  pick: (text: string, bold?: boolean) => PDFFont;
};
type PhotoLoader = (url: string, signal?: AbortSignal) => Promise<Uint8Array>;

const CHECK_COLUMNS = [0.13, 0.2, 0.17, 0.15, 0.17, 0.18] as const;
const CHECK_HEADERS = [
  'Тексеру күні\nДата проверки',
  'Тексеру себебі\nПричина проверки',
  'Электр қауіпсіздігі тобы\nГруппа электробезопасности',
  'Жалпы бағасы\nОбщая оценка',
  'Келесі тексеру күні\nДата следующей проверки',
  'Комиссия төрағасының қолы\nПодпись председателя комиссии',
];

/**
 * The booklet of an electrical course: «КУӘЛІК / УДОСТОВЕРЕНИЕ» with the
 * admission to installations on the left half and the table of knowledge
 * checks on the right, as the training centre's own booklets are printed. The
 * employer's line and «М.П.» are left blank — they belong to the company that
 * sent the person, not to the centre.
 */
export async function drawElectricalBooklet(
  pdf: PDFDocument,
  page: PDFPage,
  fonts: Fonts,
  metadata: CertificatePreviewData,
  options: {
    half: number;
    date: Date;
    until: Date | null;
    loadPhoto: PhotoLoader;
    onPhotoError: ((error: unknown) => void) | null;
    signal?: AbortSignal;
  },
) {
  const { half, date, until, signal } = options;
  const branding = metadata.branding;
  const profile = branding.documentProfile;
  const admission = personAdmission(profile?.electrical, metadata.documentDetails);
  const margin = 32;
  const usable = half - margin * 2;
  const number = branding.protocolNumber || metadata.certificateNumber;
  const txt = (
    text: string,
    x: number,
    top: number,
    width: number,
    height: number,
    size = 11,
    bold = false,
    align: 'left' | 'center' | 'right' = 'left',
    minSize = 6,
  ) => block(page, text, fonts.pick(text, bold), x, top, width, height, size, align, minSize);

  for (const x of [8, half])
    page.drawRectangle({
      x,
      y: 8,
      width: half - 8,
      height: 359,
      borderColor: ink,
      borderWidth: 0.45,
    });

  // The left half: who is admitted, to what and by whom.
  txt('КУӘЛІК / УДОСТОВЕРЕНИЕ № ' + number, margin, 24, usable, 26, 15, true, 'center');
  const field = (label: string, value: string, top: number, width = usable) => {
    const labelWidth = Math.min(fonts.regular.widthOfTextAtSize(label, 10.5) + 6, width * 0.5);
    txt(label, margin, top, labelWidth - 4, 26, 10.5);
    txt(value, margin + labelWidth, top, width - labelWidth, 26, 10.5);
    rule(page, margin + labelWidth, top + 26, width - labelWidth);
  };
  field('Берілді/Выдано:', metadata.fullName, 58);
  field('Лауазымы/Должность:', metadata.position ?? '', 86);

  const photoWidth = Math.min(155, usable * 0.3);
  const photoHeight = 196;
  const photoX = half - margin - photoWidth;
  const photoTop = 120;
  const bodyWidth = photoX - margin - 14;
  txt(
    'Жұмыс орны/Место работы: ' + (metadata.organization ?? ''),
    margin,
    116,
    bodyWidth,
    40,
    10.5,
  );
  rule(page, margin, 157, bodyWidth);
  txt(
    'Электр қондырғыларындағы кернеулі ' +
      ELECTRICAL_VOLTAGE_TEXT[admission.voltage].kk +
      ', ' +
      admission.group +
      ' топ, ' +
      ELECTRICAL_ROLE_TEXT[admission.role].kk +
      ' ретінде жұмыс істеуге рұқсат берілді.',
    margin,
    166,
    bodyWidth,
    54,
    10.5,
  );
  txt(
    'Допущен к работе на электроустановках напряжением ' +
      ELECTRICAL_VOLTAGE_TEXT[admission.voltage].ru +
      '. ' +
      admission.group +
      ' группа в качестве ' +
      ELECTRICAL_ROLE_TEXT[admission.role].ru +
      '.',
    margin,
    222,
    bodyWidth,
    50,
    10.5,
  );
  txt('Берілген күні/Дата выдачи: ' + formatIssueDate(date), margin, 274, bodyWidth, 22, 10);
  rule(page, margin, 302, bodyWidth - 40);
  txt(
    'Жұмыс беруші (электрожабдықтарға жауапты) Қолы, Т.А.Ә.\nРаботодатель (ответственный за электрохозяйство) Подпись Ф.И.О.',
    margin,
    304,
    bodyWidth - 40,
    18,
    6.4,
    false,
    'left',
    5,
  );
  txt('М.О.\nМ.П.', margin + bodyWidth - 34, 302, 34, 20, 7.5, false, 'right', 6);
  txt(
    'Біліктілігін тексеру нәтижесі болмаса жарамсыз.\nБез записи результатов проверки знаний недействительно.',
    margin,
    326,
    bodyWidth,
    18,
    6.4,
    false,
    'left',
    5,
  );
  txt(
    'Қызметтік міндеттерін атқару барысында жұмысшы куәлігі жанында болу керек.\nВо время выполнения служебных обязанностей работник должен иметь при себе удостоверение.',
    margin,
    346,
    bodyWidth,
    18,
    6.4,
    false,
    'left',
    5,
  );

  page.drawRectangle({
    x: photoX,
    y: 375 - photoTop - photoHeight,
    width: photoWidth,
    height: photoHeight,
    borderColor: ink,
    borderWidth: 0.5,
  });
  if (metadata.photoUrl) {
    const photoStarted = spanStart();
    try {
      const photo = await pdf.embedJpg(
        await options.loadPhoto(
          resolveAssetUrl(metadata.photoUrl, metadata.verificationUrl),
          signal,
        ),
      );
      const fit = Math.min((photoWidth - 2) / photo.width, (photoHeight - 2) / photo.height);
      page.drawImage(photo, {
        x: photoX + (photoWidth - photo.width * fit) / 2,
        y: 375 - photoTop - photoHeight + (photoHeight - photo.height * fit) / 2,
        width: photo.width * fit,
        height: photo.height * fit,
      });
    } catch (error) {
      if (!options.onPhotoError || signal?.aborted) throw error;
      options.onPhotoError(error);
    }
    measureSpan('doc:photo', photoStarted);
  }

  // The right half: the table the commission signs at every check.
  const right = half + margin;
  block(
    page,
    'Нормативті құжаттар мен білімін тексеру нәтижесі\nРезультат проверки знаний, нормативных документов',
    fonts.sansBold,
    right,
    22,
    usable,
    32,
    12,
    'center',
    7,
  );
  const widths = CHECK_COLUMNS.map((share) => share * usable);
  const headerHeight = 62;
  const rowHeight = 40;
  const tableTop = 64;
  const cell = (text: string, column: number, top: number, height: number, size: number) => {
    const x = right + widths.slice(0, column).reduce((sum, value) => sum + value, 0);
    page.drawRectangle({
      x,
      y: 375 - top - height,
      width: widths[column]!,
      height,
      borderColor: ink,
      borderWidth: 0.45,
    });
    if (text)
      block(
        page,
        text,
        fonts.pick(text),
        x + 3,
        top + 3,
        widths[column]! - 6,
        height - 6,
        size,
        'center',
        4.6,
      );
    return { x, width: widths[column]! };
  };
  CHECK_HEADERS.forEach((header, column) => cell(header, column, tableTop, headerHeight, 6.6));
  const checks = [
    formatShortDate(date),
    capitalize(profile?.verificationKind?.trim() || 'очередная'),
    admission.group + ' гр.',
    'Соответствует',
    until ? formatShortDate(until) : '—',
    '',
  ];
  let signatureCell = { x: right, width: widths[5]! };
  for (let row = 0; row < 4; row += 1) {
    const top = tableTop + headerHeight + row * rowHeight;
    checks.forEach((value, column) => {
      const drawn = cell(row === 0 ? value : '', column, top, rowHeight, 8);
      if (row === 0 && column === 5) signatureCell = drawn;
    });
  }

  const facsimilesStarted = spanStart();
  const [stamp, chairmanSignature] = await Promise.all([
    embedFacsimile(pdf, branding.stampUrl, metadata.verificationUrl, signal),
    embedFacsimile(
      pdf,
      branding.commissionSignatureUrls?.[0] ?? branding.chairmanSignatureUrl,
      metadata.verificationUrl,
      signal,
    ),
  ]);
  measureSpan('doc:facsimiles', facsimilesStarted);
  drawFacsimile(
    page,
    chairmanSignature,
    signatureCell.x + 3,
    tableTop + headerHeight + 6,
    signatureCell.width - 6,
    rowHeight - 12,
  );

  const qrSize = 52;
  const qrX = half * 2 - margin - qrSize;
  const lineWidth = usable - (metadata.verificationUrl ? qrSize + 12 : 0);
  const signatureLine = 322;
  rule(page, right, signatureLine, lineWidth);
  txt(
    'Комиссия төрағасы (қолы) / Председатель комиссии (подпись)',
    right,
    signatureLine + 2,
    lineWidth,
    16,
    6.6,
    false,
    'center',
    5,
  );
  const signatureWidth = 118;
  const signatureX = right + lineWidth - signatureWidth - 6;
  drawFacsimile(page, chairmanSignature, signatureX, signatureLine - 30, signatureWidth, 28);
  // The centre's own 40 mm seal over the chairman's signature, as it is stamped
  // on paper; it stays inside the frame and clear of the QR code.
  const insertHeightCm = branding.documentDefaults?.insertHeightCm;
  const stampSize = Math.min(130, insertHeightCm ? (4 * 375) / insertHeightCm : 120);
  drawFacsimile(
    page,
    stamp,
    Math.min(signatureX + signatureWidth / 2 - stampSize / 2, half * 2 - 10 - stampSize),
    Math.max(Math.min(signatureLine - stampSize * 0.62, 367 - stampSize), 200),
    stampSize,
    stampSize,
  );
  if (metadata.verificationUrl) {
    const qr = (await import('qrcode')).default.create(metadata.verificationUrl, {
      errorCorrectionLevel: 'M',
    });
    const size = qr.modules.size;
    const cellSize = qrSize / (size + 8);
    for (let row = 0; row < size; row += 1)
      for (let column = 0; column < size; column += 1)
        if (qr.modules.data[row * size + column])
          page.drawRectangle({
            x: qrX + (column + 4) * cellSize,
            y: 15 + qrSize - (row + 5) * cellSize,
            width: cellSize,
            height: cellSize,
            color: ink,
          });
  }
}

function formatShortDate(date: Date) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Oral',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}
function capitalize(text: string) {
  return text.slice(0, 1).toLocaleUpperCase('ru-RU') + text.slice(1);
}
