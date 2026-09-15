import type { CertificateBranding } from './certificate-client-contract.ts';

export type CommissionMember = { name: string; position: string };
export type DocumentDefaults = {
  reviewerName: string;
  commission: CommissionMember[];
  companyName: string;
  programName: string;
  protocolText: string;
};
export type DocumentBatch = {
  id?: string;
  organization: string;
  courseSlug: string;
  date: string;
  number: string;
  automatic: boolean;
  version: number;
};
export type DocumentParticipant = {
  userId: string;
  fullName: string;
  position: string;
  status: 'passed' | 'failed' | 'started' | 'expired' | 'none';
  score: number | null;
  total: number | null;
  certificateId: string | null;
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
export function newDocumentBatch(organization: string, courseSlug: string): DocumentBatch {
  const date = documentDate();
  return { organization, courseSlug, date, number: numberFromDate(date), automatic: true, version: 0 };
}
export function changeDocumentDate(batch: DocumentBatch, date: string): DocumentBatch {
  return { ...batch, date, number: batch.automatic ? numberFromDate(date) : batch.number };
}
export function documentCommission(branding: CertificateBranding): CommissionMember[] {
  return branding.documentDefaults?.commission ?? [
    { name: branding.memberName, position: branding.memberPosition },
    { name: branding.secondMemberName, position: branding.secondMemberPosition },
  ].filter((member) => member.name);
}
export function documentStatement(text: string, branding: CertificateBranding, program: string) {
  return text.replaceAll('{protocol}', branding.protocolNumber)
    .replaceAll('{program}', program);
}
export function participantResult(person: DocumentParticipant) {
  const result = { passed: 'Сдал', failed: 'Не сдал', started: 'Не завершил', expired: 'Время истекло', none: 'Проверка не пройдена' }[person.status];
  return person.score !== null && person.total !== null ? `${result} (${person.score}/${person.total})` : result;
}
