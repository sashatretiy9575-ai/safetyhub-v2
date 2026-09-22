import type { CertificateBranding } from './certificate-client-contract.ts';

export type CommissionMember = { name: string; position: string };
export type DocumentDefaults = {
  reviewerName: string;
  commission: CommissionMember[];
  companyName: string;
  programName: string;
  protocolText: string;
  insertWidthCm?: number | null;
  insertHeightCm?: number | null;
};
export type DocumentParticipant = {
  userId: string;
  fullName: string;
  position: string;
  education?: string;
  photoUrl?: string | null;
  status: 'passed' | 'failed' | 'started' | 'expired' | 'none';
  score: number | null;
  total: number | null;
  certificateId: string | null;
  workExperience?: string;
  verificationKind?: string;
  trainingReason?: string;
  notes?: string;
  qualificationDecision?: string;
  organization?: string;
  formalExamReference?: string;
  formalExamDate?: string;
  formalExamResult?: string;
  formalExamProfileId?: string;
  formalExamProfileVersion?: number;
};
export const DOCUMENT_DEFAULTS: DocumentDefaults = {
  reviewerName: 'Битемиров А.У.',
  commission: [
    { name: 'Ахметжанов Е.М.', position: 'Преподаватель ТОО «Work Safety (Уорк Сэйфти)»' },
    { name: 'Кудияров А.М.', position: 'Преподаватель ТОО «Work Safety (Уорк Сэйфти)»' },
  ],
  companyName: 'Филиал Китайской Инжиниринговой Корпорации Тяньчэнь в Республике Казахстан',
  programName: 'Работа на высоте',
  protocolText: 'Проверка знаний проведена в соответствии с утвержденной программой на тему: «{program}»',
};

export function documentDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Oral', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function numberFromDate(date: string) {
  return `${date.slice(8, 10)}.${date.slice(5, 7)}`;
}
/**
 * One commission sitting takes at most fifty people, so a protocol lists no
 * more: the fifty-first person of the same company, course and day opens
 * «DD.MM-2». The number is fixed at issue by `private.capture_document_snapshot`,
 * which keeps the same limit.
 */
export const PROTOCOL_MAX_PARTICIPANTS = 50;
export function documentCommission(branding: CertificateBranding): CommissionMember[] {
  return branding.documentDefaults?.commission ?? [
    { name: branding.memberName, position: branding.memberPosition },
    { name: branding.secondMemberName, position: branding.secondMemberPosition },
  ].filter((member) => member.name);
}
export function documentStatement(text: string, branding: CertificateBranding, program: string) {
  return text.replaceAll('{protocol}', branding.protocolNumber)
    .replaceAll('{program}', branding.documentProfile?.programName ?? program);
}

/** The open spread in centimetres: the smallest and the largest the layout is drawn for. */
export const INSERT_SIZE_LIMITS = { insertWidthCm: [8, 60], insertHeightCm: [4, 30] } as const;
export type InsertSizeKey = keyof typeof INSERT_SIZE_LIMITS;
/** The side of the insert that is filled in but cannot be printed, if there is one. */
export function insertSizeProblem(
  defaults: Pick<DocumentDefaults, InsertSizeKey> | null | undefined,
): InsertSizeKey | null {
  for (const key of ['insertWidthCm', 'insertHeightCm'] as const) {
    const size = defaults?.[key];
    const [min, max] = INSERT_SIZE_LIMITS[key];
    if (size != null && (typeof size !== 'number' || !Number.isFinite(size) || size < min || size > max)) return key;
  }
  return null;
}
export function participantResult(person: DocumentParticipant) {
  const result = { passed: 'Сдал', failed: 'Не сдал', started: 'Не завершил', expired: 'Время истекло', none: 'Проверка не пройдена' }[person.status];
  return person.score !== null && person.total !== null ? `${result} (${person.score}/${person.total})` : result;
}
