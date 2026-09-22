import type { CertificateBranding } from './certificate-client-contract.ts';
import type { DocumentDefaults } from './document-editor.ts';
import {
  applyDocumentProfile,
  withDocumentCommission,
  type BookletTexts,
  type DocumentCommission,
  type DocumentFamily,
  type DocumentProfileSettings,
} from './document-profile.ts';

/**
 * A course's documents as the administrator sets them up: one form of
 * protocol, one category or «ИТР» and «рабочий состав», the hours and the term
 * of each category, one wording and one booklet for the whole course. Stored,
 * it is one document profile per category; `save_document_course` in the
 * database writes all of them in one transaction.
 */
export type DocumentAudienceKey = DocumentProfileSettings['audience'];
export type CourseDocumentCategory = {
  /** Null takes the hours of the form. */
  hours: number | null;
  /** Null takes the term of the form; 0 is «без срока». */
  validityMonths: number | null;
};
export type CourseDocumentDraft = {
  family: DocumentFamily;
  split: boolean;
  programName: string;
  protocolText: string;
  decisionText: string;
  orderNumber: string;
  orderDate: string;
  verificationKind: string;
  /** Null prints the booklet of «Общее». */
  booklet: BookletTexts | null;
  categories: Partial<Record<DocumentAudienceKey, CourseDocumentCategory>>;
};
/** One course and the profiles it is stored as, each with its version. */
export type CourseDocumentSetup = {
  courseId: string;
  slug: string;
  title: string;
  published: boolean;
  profiles: DocumentProfileSettings[];
};

export const SPLIT_AUDIENCES = ['itr', 'worker'] as const;
export const DOCUMENT_FAMILY_LABELS: Readonly<Record<DocumentFamily, string>> = {
  general: 'Общий',
  biot: 'БиОТ',
  ptm: 'ПТМ',
  industrial: 'Промбез',
  qualification: 'Квалификационный',
  'first-aid': 'Первая помощь',
};
export const AUDIENCE_LABELS: Readonly<Record<DocumentAudienceKey, string>> = {
  all: '',
  itr: 'ИТР',
  worker: 'Рабочие',
};

export function draftAudiences(draft: Pick<CourseDocumentDraft, 'split'>): DocumentAudienceKey[] {
  return draft.split ? [...SPLIT_AUDIENCES] : ['all'];
}

function categoryOf(profile: DocumentProfileSettings): CourseDocumentCategory {
  return {
    hours: profile.hours || null,
    validityMonths: profile.noExpiry ? 0 : profile.validityMonths || null,
  };
}

/**
 * The draft a course's stored profiles describe. The wording is one for the
 * whole course; profiles written before that could differ, and the ИТР one
 * then speaks for both.
 */
export function courseDocumentDraft(setup: CourseDocumentSetup): CourseDocumentDraft {
  const order: DocumentAudienceKey[] = ['all', 'itr', 'worker'];
  const profiles = [...setup.profiles].sort(
    (a, b) => order.indexOf(a.audience) - order.indexOf(b.audience),
  );
  const lead = profiles[0];
  const split = !profiles.some((profile) => profile.audience === 'all') && profiles.length > 1;
  const categories: CourseDocumentDraft['categories'] = {};
  for (const profile of profiles) categories[profile.audience] = categoryOf(profile);
  return {
    family: lead?.family ?? 'general',
    split,
    programName: lead?.programName || setup.title,
    protocolText: lead?.protocolText ?? '',
    decisionText: lead?.decisionText ?? '',
    orderNumber: lead?.orderNumber ?? '',
    orderDate: lead?.orderDate ?? '',
    verificationKind: lead?.verificationKind ?? '',
    booklet: lead?.booklet?.texts ?? null,
    categories,
  };
}

/** What the database is sent: only the categories the course keeps. */
export function courseDocumentPayload(draft: CourseDocumentDraft) {
  const categories: Partial<Record<DocumentAudienceKey, CourseDocumentCategory>> = {};
  for (const audience of draftAudiences(draft)) {
    const category = draft.categories[audience];
    categories[audience] = {
      hours: category?.hours ?? null,
      validityMonths: category?.validityMonths ?? null,
    };
  }
  return {
    family: draft.family,
    split: draft.split,
    programName: draft.programName.trim(),
    protocolText: draft.protocolText.trim(),
    decisionText: draft.decisionText.trim(),
    orderNumber: draft.family === 'biot' ? draft.orderNumber.trim() : '',
    orderDate: draft.family === 'biot' ? draft.orderDate : '',
    verificationKind: draft.verificationKind.trim(),
    booklet: draft.booklet ? { layout: 'standard' as const, texts: draft.booklet } : null,
    categories,
  };
}

/** The versions the draft was read at: a save made elsewhere in between is refused. */
export function courseDocumentVersions(setup: CourseDocumentSetup) {
  return Object.fromEntries(setup.profiles.map((profile) => [profile.id, profile.revision ?? 1]));
}

/** The profile of one category as the draft would store it, for the preview. */
export function draftProfile(
  setup: CourseDocumentSetup,
  draft: CourseDocumentDraft,
  audience: DocumentAudienceKey,
): DocumentProfileSettings {
  const payload = courseDocumentPayload(draft);
  const category = payload.categories[audience] ?? { hours: null, validityMonths: null };
  const stored = setup.profiles.find((profile) => profile.audience === audience);
  const suffix = audience === 'itr' ? ' — ИТР' : audience === 'worker' ? ' — рабочий состав' : '';
  return {
    id: stored?.id ?? `${setup.slug}-${audience}`,
    courseSlug: setup.slug,
    audience,
    label: `${payload.programName}${suffix}`,
    programName: payload.programName || setup.title,
    family: payload.family,
    hours: category.hours,
    validityMonths: category.validityMonths ?? 0,
    ...(category.validityMonths === 0 ? { noExpiry: true } : {}),
    protocolText: payload.protocolText,
    decisionText: payload.decisionText,
    orderNumber: payload.orderNumber,
    orderDate: payload.orderDate,
    verificationKind: payload.verificationKind,
    ...(payload.booklet ? { booklet: payload.booklet } : {}),
  };
}

/** «Общее» as the renderer needs it; the images come from the commission. */
export type CommonDocumentSettings = {
  organizationName: string;
  bin: string;
  validityMonths: number;
  examTextKk: string;
  examTextRu: string;
  knowledgeTextKk: string;
  knowledgeTextRu: string;
  documentDefaults: DocumentDefaults;
  documentCommission: DocumentCommission;
};

/**
 * What a document of this course would look like if it were issued today with
 * these settings: the same assembly issuance performs, so the preview and the
 * printed document cannot disagree.
 */
export function previewBranding(
  common: CommonDocumentSettings,
  profile: DocumentProfileSettings,
  protocol: { date: string; number: string },
): CertificateBranding {
  const [chairman] = common.documentCommission.signers;
  const base: CertificateBranding = {
    documentDefaults: common.documentDefaults,
    organizationName: common.organizationName,
    bin: common.bin,
    chairmanName: chairman?.name ?? '',
    chairmanPosition: chairman?.position ?? '',
    memberName: '',
    memberPosition: '',
    secondMemberName: '',
    secondMemberPosition: '',
    protocolNumber: protocol.number,
    protocolDate: protocol.date,
    protocolLayoutVersion: 2,
    validityMonths: common.validityMonths,
    examTextKk: common.examTextKk,
    examTextRu: common.examTextRu,
    knowledgeTextKk: common.knowledgeTextKk,
    knowledgeTextRu: common.knowledgeTextRu,
    stampUrl: null,
    chairmanSignatureUrl: null,
    memberSignatureUrl: null,
    protocolSignatureUrl: null,
  };
  return applyDocumentProfile(base, withDocumentCommission(profile, common.documentCommission));
}
