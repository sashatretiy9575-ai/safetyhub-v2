import type { DocumentFamily, DocumentProfileSettings } from './document-profile.ts';

export type DocumentAudience = DocumentProfileSettings['audience'];

/**
 * What the training centre's own protocols already say, for every programme and
 * every listener. All of it used to be typed in by hand: an empty «вид проверки
 * знаний», «причина обучения» or «решение комиссии» refused the issuance outright,
 * although the paper form has carried the same wording for years. The defaults
 * below are the wording of those forms; a profile only stores a value when the
 * administrator deliberately overrides one.
 *
 * `private.document_family_default` in the database repeats these values: the
 * issuance trigger fills the same blanks, so a document issued in bulk and a
 * document previewed in the editor cannot disagree.
 */
export type DocumentFamilyDefaults = {
  /** Null where the paper form does not state a volume — then nothing is printed. */
  hours: Record<DocumentAudience, number | null>;
  validityMonths: Record<DocumentAudience, number>;
  verificationKind: string;
  trainingReason: string;
  protocolText: string;
  decisionText: string;
};

const HOURS_BY_LEVEL = { all: 40, itr: 40, worker: 10 } as const;
const NO_HOURS = { all: null, itr: null, worker: null } as const;
const VALIDITY_BY_LEVEL = { all: 36, itr: 36, worker: 12 } as const;

const PASSED_TO_WORK =
  'Лица, получившие положительные оценки, допускаются к самостоятельной работе, к выполнению (руководству) соответствующих работ на опасных производственных объектах.';
const CIVIL_PROTECTION_ACT =
  'Закона Республики Казахстан от 11 апреля 2014 года № 188-V «О гражданской защите»';

export const DOCUMENT_FAMILY_DEFAULTS: Record<DocumentFamily, DocumentFamilyDefaults> = {
  general: {
    hours: NO_HOURS,
    validityMonths: { all: 12, itr: 12, worker: 12 },
    verificationKind: '',
    trainingReason: '',
    protocolText: 'Проверка знаний проведена по утверждённой программе учебного курса «{program}».',
    decisionText: PASSED_TO_WORK,
  },
  biot: {
    // The law sets 40 hours for engineers and managers and 10 for workers.
    hours: HOURS_BY_LEVEL,
    validityMonths: VALIDITY_BY_LEVEL,
    verificationKind: 'периодический',
    trainingReason: '',
    protocolText:
      'Проверка знаний по безопасности и охране труда проведена по утверждённой программе «{program}».',
    decisionText:
      'Лица, прошедшие проверку знаний, допускаются к самостоятельной работе. Не прошедшие проверку подлежат повторной проверке знаний по безопасности и охране труда.',
  },
  ptm: {
    hours: HOURS_BY_LEVEL,
    validityMonths: VALIDITY_BY_LEVEL,
    verificationKind: '',
    trainingReason: 'Первичный',
    protocolText:
      'Экзамен по пожарной безопасности принят в объёме пожарно-технического минимума по утверждённой программе «{program}».',
    decisionText: PASSED_TO_WORK,
  },
  industrial: {
    hours: HOURS_BY_LEVEL,
    validityMonths: { all: 36, itr: 36, worker: 36 },
    verificationKind: '',
    trainingReason: '',
    protocolText:
      'Проверка знаний проведена в соответствии с утверждённой программой «Подготовка, переподготовка специалистов, работников опасных производственных объектов по вопросам промышленной безопасности» на основании ' +
      CIVIL_PROTECTION_ACT +
      ' — «{program}».',
    decisionText: PASSED_TO_WORK,
  },
  qualification: {
    hours: NO_HOURS,
    // A certificate of a trade is not re-checked on a calendar: it states a
    // qualification, so the booklet prints no expiry at all.
    validityMonths: { all: 0, itr: 0, worker: 0 },
    verificationKind: '',
    trainingReason: '',
    protocolText:
      'Подведены итоги профессиональной подготовки по специальности «{program}» и принято решение о выдаче свидетельства.',
    decisionText:
      'Квалификационная комиссия приняла решение о выдаче свидетельства по специальности.',
  },
  'first-aid': {
    hours: { all: 8, itr: 8, worker: 8 },
    validityMonths: { all: 12, itr: 12, worker: 12 },
    verificationKind: '',
    trainingReason: '',
    protocolText: 'Обучение проведено по утверждённой программе «{program}».',
    decisionText:
      'Лица, прошедшие обучение, допускаются к оказанию первой доврачебной помощи в объёме программы.',
  },
};

export function documentFamilyDefaults(family: DocumentFamily | null | undefined) {
  return DOCUMENT_FAMILY_DEFAULTS[family ?? 'general'] ?? DOCUMENT_FAMILY_DEFAULTS.general;
}

/**
 * The profile as it is printed: every blank the administrator never filled in
 * carries the wording of the paper form. Stored values always win, so one
 * deliberate override is never overwritten by a default. A term of 0 months is
 * a blank too; «без срока» is said with `noExpiry`.
 */
export function completeDocumentProfile<T extends DocumentProfileSettings>(profile: T): T {
  const defaults = documentFamilyDefaults(profile.family);
  return {
    ...profile,
    hours: profile.hours ?? defaults.hours[profile.audience],
    validityMonths: profile.noExpiry
      ? 0
      : profile.validityMonths || defaults.validityMonths[profile.audience],
    verificationKind: profile.verificationKind.trim() || defaults.verificationKind,
    protocolText: profile.protocolText.trim() || defaults.protocolText,
    decisionText: profile.decisionText.trim() || defaults.decisionText,
  };
}

/**
 * The per-listener cell of the protocol table. It is the same word for everyone
 * in the group, so it is derived rather than asked for; a value the administrator
 * typed for one person still wins.
 */
export function completeParticipantFields(
  family: DocumentFamily | null | undefined,
  programName: string,
  fields: { trainingReason?: string; qualificationDecision?: string; notes?: string },
) {
  const defaults = documentFamilyDefaults(family);
  return {
    trainingReason: fields.trainingReason?.trim() || defaults.trainingReason,
    qualificationDecision:
      fields.qualificationDecision?.trim() || (family === 'qualification' ? programName : ''),
    // The owner's protocols leave «Примечание» empty on every line; it is a
    // column on the form, never a question the operator has to answer.
    notes: fields.notes?.trim() ?? '',
  };
}

/**
 * Which listener category a person belongs to, read from the position they hold.
 * Programmes split into «ИТР» and «рабочий состав» used to refuse an issuance
 * until somebody opened the editor and picked one by hand.
 */
const SUPERVISORY_POSITION =
  /(руковод|директор|начальн|замести|инженер|мастер|бригадир|прораб|специалист|технолог|менеджер|главн|завед|супервайз|superv|manager|engineer|foreman|director|chief|head)/iu;

export function documentAudienceForPosition(position: string | null | undefined) {
  return SUPERVISORY_POSITION.test(position ?? '') ? 'itr' : 'worker';
}
