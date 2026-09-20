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
export type DocumentProfile = {
  revision?: number;
  id: string;
  courseSlug: string;
  audience: 'all' | 'worker' | 'itr';
  label: string;
  programName: string;
  family: DocumentFamily;
  hours: number | null;
  validityMonths: number;
  protocolText: string;
  decisionText: string;
  orderNumber: string;
  orderDate: string;
  verificationKind: string;
  commission: DocumentSigner[];
  stampAssetId: string | null;
};

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

export function protocolColumns(family: DocumentFamily, layoutVersion?: 2) {
  if (family === 'first-aid' && layoutVersion === 2)
    return ['№', 'Ф.И.О.', 'Занимаемая должность', 'Организация', 'Результат сдачи экзаменов'];
  if (family === 'ptm')
    return [
      '№',
      'ФИО обучающегося',
      'Должность',
      'Организация (участок, цех)',
      'Причина обучения',
      'Отметка',
      'Подпись',
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
    ];
  return ['№', 'Ф.И.О.', 'Занимаемая должность', 'Образование', 'Результат сдачи экзаменов'];
}
