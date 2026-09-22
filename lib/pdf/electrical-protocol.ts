import type { PDFDocument, PDFFont, PDFImage, PDFPage } from 'pdf-lib';
import type { CertificateBranding } from './certificate-client-contract.ts';
import { formatIssueDate, certificateValidUntil } from './certificate-renderer.ts';
import { documentCommission, type DocumentParticipant } from './document-editor.ts';
import { rule } from './document-layout.ts';
import { drawFacsimile } from './document-layout.ts';
import { ink } from './document-layout.ts';
import { electricalAdmissionText, electricalGroupText, personAdmission } from './electrical.ts';
import { documentTextWidth, wrapDocumentText } from './protocol-renderer.ts';

type Fonts = { regular: PDFFont; bold: PDFFont; pick: (text: string, bold?: boolean) => PDFFont };

const LEFT = 85;
const WIDTH = 467;
const RIGHT = LEFT + WIDTH;

/**
 * The qualification protocol of one person: «Приложение 1 к Правилам работы с
 * персоналом в энергетических организациях Республики Казахстан». Unlike every
 * other form of the training centre it is not a table of a sitting — each
 * person has a sheet and a number of their own — so the group of admission,
 * the kind of check and the date of the next one are stated in full.
 */
export function drawElectricalProtocol(
  page: PDFPage,
  fonts: Fonts,
  person: DocumentParticipant,
  options: {
    branding: CertificateBranding;
    organization: string;
    date: Date;
    number: string;
    scale: number;
    stamp: PDFImage | null;
    signatures: readonly (PDFImage | null)[];
  },
) {
  const { branding, scale } = options;
  const profile = branding.documentProfile;
  const admission = personAdmission(profile?.electrical, person);
  let y = 46;

  const draw = (text: string, font: PDFFont, x: number, size: number, width: number) => {
    const lines = wrapDocumentText(font, text, size, width);
    for (const [index, line] of lines.entries())
      page.drawText(line, {
        x,
        y: page.getHeight() - y - size - index * size * 1.25,
        size,
        font,
        color: ink,
      });
    return lines;
  };

  /** A line of the form: its printed caption under it, in the small print of the original. */
  const caption = (text: string, x = LEFT, width = WIDTH, align: 'left' | 'center' = 'left') => {
    const size = 7.6 * scale;
    const lines = wrapDocumentText(fonts.regular, text, size, width);
    for (const [index, line] of lines.entries()) {
      const offset =
        align === 'center' ? (width - documentTextWidth(fonts.regular, line, size)) / 2 : 0;
      page.drawText(line, {
        x: x + offset,
        y: page.getHeight() - y - size - index * size * 1.2,
        size,
        font: fonts.regular,
        color: ink,
      });
    }
    y += lines.length * size * 1.2 + 1.5 * scale;
  };

  const paragraph = (
    text: string,
    size = 11,
    align: 'left' | 'center' | 'right' = 'left',
    bold = false,
  ) => {
    const scaled = size * scale;
    const font = fonts.pick(text, bold);
    for (const line of text.split('\n')) {
      const lines = wrapDocumentText(font, line, scaled, WIDTH);
      for (const part of lines) {
        const width = documentTextWidth(font, part, scaled);
        const x =
          align === 'center'
            ? LEFT + (WIDTH - width) / 2
            : align === 'right'
              ? RIGHT - width
              : LEFT;
        page.drawText(part, {
          x,
          y: page.getHeight() - y - scaled,
          size: scaled,
          font,
          color: ink,
        });
        y += scaled * 1.25;
      }
    }
    y += 2 * scale;
  };

  /** «Label ______value______»: the value is written on the rule, as it is filled in by hand. */
  const field = (label: string, value: string, size = 11) => {
    const scaled = size * scale;
    const labelWidth = label ? documentTextWidth(fonts.regular, label, scaled) + 5 : 0;
    if (label) draw(label, fonts.regular, LEFT, scaled, WIDTH);
    const valueFont = fonts.pick(value, false);
    const lines = wrapDocumentText(valueFont, value, scaled, WIDTH - labelWidth);
    lines.forEach((line, index) => {
      const x = index === 0 ? LEFT + labelWidth : LEFT;
      const width = index === 0 ? WIDTH - labelWidth : WIDTH;
      page.drawText(line, {
        x,
        y: page.getHeight() - y - scaled - index * scaled * 1.25,
        size: scaled,
        font: valueFont,
        color: ink,
      });
      rule(page, x, y + scaled * 1.2 + index * scaled * 1.25, width);
    });
    y += Math.max(1, lines.length) * scaled * 1.25 + 2 * scale;
  };

  const date = options.date;
  const until = certificateValidUntil(date, profile?.validityMonths ?? branding.validityMonths);
  const members = documentCommission(branding);
  const signatureLine = (label: string, name: string, image: PDFImage | null, note: string) => {
    const size = 11 * scale;
    const labelWidth = label ? documentTextWidth(fonts.regular, label, size) + 5 : 0;
    if (label) draw(label, fonts.regular, LEFT, size, WIDTH);
    // A Chinese name is set in the face that has its characters.
    const nameFont = fonts.pick(name);
    const nameWidth = documentTextWidth(nameFont, name, size);
    page.drawText(name, {
      x: RIGHT - nameWidth,
      y: page.getHeight() - y - size,
      size,
      font: nameFont,
      color: ink,
    });
    const lineStart = LEFT + labelWidth;
    const lineWidth = Math.max(60, RIGHT - nameWidth - 8 - lineStart);
    rule(page, lineStart, y + size * 1.2, lineWidth);
    // The signature is written on the rule, ending where the name begins.
    const facsimileWidth = Math.min(128, lineWidth - 10);
    drawFacsimile(
      page,
      image,
      lineStart + lineWidth - facsimileWidth,
      y - size * 1.5,
      facsimileWidth,
      size * 2.4,
    );
    y += size * 1.3;
    caption(note, lineStart, WIDTH - labelWidth);
  };

  // The head of the form: which rules the sheet belongs to.
  for (const line of [
    'Приложение 1',
    'к Правилам работы с персоналом',
    'в энергетических организациях',
    'Республики Казахстан',
  ]) {
    const size = 9.5 * scale;
    const width = documentTextWidth(fonts.regular, line, size);
    page.drawText(line, {
      x: RIGHT - width,
      y: page.getHeight() - y - size,
      size,
      font: fonts.regular,
      color: ink,
    });
    y += size * 1.22;
  }
  y += 14 * scale;
  paragraph('ПРОТОКОЛ №' + options.number, 12.5, 'center', true);
  paragraph('квалификационной проверки знаний', 12, 'center', true);
  y += 8 * scale;

  field('Дата проведения квалификационной проверки знаний ', formatIssueDate(date));
  field('Комиссия (Центральная/структурного подразделения) ', branding.organizationName);
  caption('(наименование организации)', LEFT, WIDTH, 'center');
  paragraph('в составе:', 9.5);
  field('Председатель: ', branding.chairmanPosition + ' ' + branding.chairmanName);
  caption('(должность, Фамилия, имя, отчество (при наличии))', LEFT + 40, WIDTH - 40);
  for (const [index, member] of members.entries()) {
    field(index === 0 ? 'Члены комиссии: ' : '', member.position + ' ' + member.name);
    caption('(должность, Фамилия, имя, отчество (при наличии))', LEFT + 40, WIDTH - 40);
  }

  y += 6 * scale;
  paragraph('Провела квалификационную проверку знаний', 11);
  field('', person.fullName + ', ' + (person.organization ?? options.organization));
  field('', [person.position, electricalGroupText(admission)].filter(Boolean).join(', '));
  caption(
    '(Фамилия, имя, отчество (при наличии), место работы, должность, профессия, разряд, группа допуска по электробезопасности,',
  );
  field('', formatIssueDate(date));
  caption('дата последней квалификационной проверки знаний)', LEFT + 40, WIDTH - 40);
  field('Вид квалификационной проверки знаний: ', profile?.verificationKind?.trim() || 'очередная');
  caption('(первичная, периодическая (очередная), внеочередная, причины)', LEFT + 40, WIDTH - 40);

  paragraph('Заключение комиссии:', 11);
  field('1. Присвоена группа допуска по электробезопасности – ', electricalGroupText(admission));
  field(
    '2. Соответствует/не соответствует занимаемой должности – ',
    person.status === 'passed' ? 'Соответствует' : 'Не соответствует',
  );
  paragraph('3. Установить срок дублирования ____ – ____ смен', 11);
  field('4. Сроки повторной проверки ', until ? formatIssueDate(until) : 'не устанавливаются');
  field(
    'Дополнительные сведения: ',
    [electricalAdmissionText(admission), person.notes?.trim()].filter(Boolean).join('. '),
  );

  y += 10 * scale;
  paragraph('Подписи:', 10);
  signatureLine(
    'Председатель комиссии ',
    branding.chairmanName,
    options.signatures[0] ?? null,
    '(подпись, Фамилия, имя, отчество (при наличии))',
  );
  for (const [index, member] of members.entries())
    signatureLine(
      index === 0 ? 'Члены комиссии: ' : '',
      member.name,
      options.signatures[index + 1] ?? null,
      '(подпись, Фамилия, имя, отчество (при наличии))',
    );
  y += 12 * scale;
  signatureLine(
    'С заключением комиссии ознакомлен ',
    person.fullName,
    null,
    '(подпись, Фамилия, имя, отчество (при наличии) проверяемого лица)',
  );
  return y;
}

/** Every person of the sitting on a sheet of their own, at the largest size that fits. */
export function drawElectricalProtocols(
  pdf: PDFDocument,
  fonts: Fonts,
  people: readonly DocumentParticipant[],
  options: {
    branding: CertificateBranding;
    organization: string;
    date: Date;
    number: string;
    stamp: PDFImage | null;
    signatures: readonly (PDFImage | null)[];
  },
) {
  const list = people.length ? people : [];
  for (const person of list) {
    let scale = 1;
    let page = pdf.addPage([595.28, 841.89]);
    // A long name, a long company and six people in the commission still fit on
    // the one sheet the form is: the sheet is drawn again a little tighter.
    for (;;) {
      const bottom = drawElectricalProtocol(page, fonts, person, { ...options, scale });
      if (bottom <= 800 || scale <= 0.76) break;
      pdf.removePage(pdf.getPageCount() - 1);
      page = pdf.addPage([595.28, 841.89]);
      scale -= 0.06;
    }
  }
}
