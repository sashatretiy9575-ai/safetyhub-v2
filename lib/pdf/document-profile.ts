import type { CertificateBranding } from './certificate-client-contract.ts';
import { completeDocumentProfile } from './document-family-defaults.ts';

export const DOCUMENT_FAMILIES = [
  'general',
  'biot',
  'ptm',
  'industrial',
  'qualification',
  'first-aid',
] as const;
export type DocumentFamily = (typeof DOCUMENT_FAMILIES)[number];
export type DocumentSigner = {
  signerId: string;
  name: string;
  position: string;
  assetId: string | null;
};
/**
 * The commission and the stamp. One for every course: it is kept once, with
 * the rest of «Общее», and written into a document's profile when the document
 * is issued, so an issued document keeps the people it was signed by.
 */
export type DocumentCommission = {
  /** The chairman first, then the members in the order they sign. */
  signers: DocumentSigner[];
  stampAssetId: string | null;
};
/** The training centre's own seal: the one stamp every document carries. */
export const DOCUMENT_STAMP_OWNER = 'work-safety';
/** A person added to the commission; their signatures are registered under this id. */
export function newDocumentSignerId() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `signer-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
export const BOOKLET_TEXT_KEYS = [
  'examTextKk',
  'examTextRu',
  'knowledgeTextKk',
  'knowledgeTextRu',
] as const;
export type BookletTexts = Record<(typeof BOOKLET_TEXT_KEYS)[number], string>;
/**
 * A course's own booklet. Absent, the course prints the booklet of «Общее».
 * Every booklet is drawn on the standard layout today; the samples the
 * training centre sends for other kinds of training become further layouts.
 */
export type DocumentBooklet = { layout: 'standard'; texts: BookletTexts };
/** A course's documents for one listener category, as they are stored. */
export type DocumentProfileSettings = {
  revision?: number;
  id: string;
  courseSlug: string;
  audience: 'all' | 'worker' | 'itr';
  label: string;
  programName: string;
  family: DocumentFamily;
  hours: number | null;
  validityMonths: number;
  /** «Без срока» for a form that has a term by default; 0 months alone means "the form's term". */
  noExpiry?: boolean;
  protocolText: string;
  decisionText: string;
  orderNumber: string;
  orderDate: string;
  verificationKind: string;
  booklet?: DocumentBooklet;
};
/** The profile a document is drawn from: its settings and the commission of the day. */
export type DocumentProfile = DocumentProfileSettings & {
  commission: DocumentSigner[];
  stampAssetId: string | null;
};

/** The settings of a course with the commission written in, as issuance writes it. */
export function withDocumentCommission(
  profile: DocumentProfileSettings,
  commission: DocumentCommission,
): DocumentProfile {
  return { ...profile, commission: commission.signers, stampAssetId: commission.stampAssetId };
}

export function registeredDocumentAssetUrl(id: string) {
  return `/certificate-assets/registered?id=${id}`;
}

/** A profile contains explicit identity-to-image links; never infer a signature by row number. */
export function applyDocumentProfile(
  branding: CertificateBranding,
  stored: DocumentProfile,
): CertificateBranding {
  const profile = completeDocumentProfile(stored);
  const [chairman, ...members] = profile.commission;
  const signature = (person: DocumentSigner | undefined) =>
    person?.assetId ? registeredDocumentAssetUrl(person.assetId) : null;
  return {
    ...branding,
    documentProfile: profile,
    chairmanName: chairman?.name ?? '',
    chairmanPosition: chairman?.position ?? '',
    memberName: members[0]?.name ?? '',
    memberPosition: members[0]?.position ?? '',
    secondMemberName: members[1]?.name ?? '',
    secondMemberPosition: members[1]?.position ?? '',
    validityMonths: profile.validityMonths,
    ...(profile.booklet ? profile.booklet.texts : {}),
    stampUrl: profile.stampAssetId ? registeredDocumentAssetUrl(profile.stampAssetId) : null,
    chairmanSignatureUrl: signature(chairman),
    protocolSignatureUrl: signature(chairman),
    memberSignatureUrl: signature(members[0]),
    commissionSignatureUrls: profile.commission.map(signature),
    documentDefaults: {
      reviewerName: '',
      companyName: '',
      ...branding.documentDefaults,
      programName: profile.programName,
      protocolText: profile.protocolText,
      commission: members.map(({ name, position }) => ({ name, position })),
    },
  };
}

/**
 * Every protocol ends with «Примечание». The column is empty on the sheets the
 * training centre prints, and the owner asked for it on all of them and not only
 * on the «БиОТ» form, so that a note can be written for one listener whatever
 * programme the sitting was for.
 */
export function protocolColumns(family: DocumentFamily, layoutVersion?: 2) {
  if (family === 'first-aid' && layoutVersion === 2)
    return [
      '№',
      'Ф.И.О.',
      'Занимаемая должность',
      'Организация',
      'Результат сдачи экзаменов',
      'Примечание',
    ];
  if (family === 'ptm')
    return [
      '№',
      'ФИО обучающегося',
      'Должность',
      'Организация (участок, цех)',
      'Причина обучения',
      'Отметка',
      'Подпись',
      'Примечание',
    ];
  if (family === 'biot')
    return [
      '№ п/п',
      'Тегі, аты / Фамилия, инициалы',
      'Ұйым атауы / Наименование организации',
      'Лауазымы / Должность',
      'Отметка о проверке знаний',
      'Примечание',
    ];
  if (family === 'qualification')
    return [
      '№',
      'Тегі, аты, әкесінің аты / Фамилия, имя, отчество',
      'Ұйым атауы / Наименование организации',
      'Лауазымы / Должность',
      'Результат подготовки',
      'Решение квалификационной комиссии по специальности',
      'Примечание',
    ];
  return [
    '№',
    'Ф.И.О.',
    'Занимаемая должность',
    'Образование',
    'Результат сдачи экзаменов',
    'Примечание',
  ];
}
