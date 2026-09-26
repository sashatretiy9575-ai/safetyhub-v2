/**
 * Admission to electrical installations, as the paper documents of the
 * training centre state it: a group, the voltage it is given for and the kind
 * of personnel the holder is. It is what the qualification protocol
 * («Приложение 1 к Правилам работы с персоналом в энергетических организациях
 * Республики Казахстан») and the electrical booklet print instead of the
 * protocol table of every other programme.
 *
 * The course names the usual admission; the administrator may give one person
 * another group or another voltage from their card. `private.electrical_*` in
 * the database repeats these lists and this wording.
 */
export const ELECTRICAL_GROUPS = ['II', 'III', 'IV', 'V'] as const;
export type ElectricalGroup = (typeof ELECTRICAL_GROUPS)[number];
export const ELECTRICAL_VOLTAGES = ['up-to-1000', 'above-1000'] as const;
export type ElectricalVoltage = (typeof ELECTRICAL_VOLTAGES)[number];
export const ELECTRICAL_ROLES = [
  'electrotechnical',
  'electrotechnological',
  'administrative',
  'operational',
  'maintenance',
] as const;
export type ElectricalRole = (typeof ELECTRICAL_ROLES)[number];

export type ElectricalAdmission = {
  group: ElectricalGroup;
  voltage: ElectricalVoltage;
  role: ElectricalRole;
  /** The number the centre's journal runs on from; each sheet takes the next free one. */
  journalStart?: number;
};

/** A journal number the database accepts: 1 to 999 999 999. */
export function isJournalStart(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 999_999_999;
}

/** What the sample protocol of the training centre states: II group up to 1000 V. */
export const ELECTRICAL_DEFAULT: ElectricalAdmission = {
  group: 'II',
  voltage: 'up-to-1000',
  role: 'electrotechnical',
};

export const ELECTRICAL_VOLTAGE_TEXT: Readonly<
  Record<ElectricalVoltage, { label: string; ru: string; kk: string }>
> = {
  'up-to-1000': { label: 'до 1000 В', ru: 'до 1000 В', kk: '1000 В дейін' },
  'above-1000': {
    label: 'выше 1000 В',
    ru: 'до и выше 1000 В',
    kk: '1000 В дейін және одан жоғары',
  },
};

export const ELECTRICAL_ROLE_TEXT: Readonly<
  Record<ElectricalRole, { label: string; ru: string; kk: string }>
> = {
  electrotechnical: {
    label: 'Электротехнический персонал',
    ru: 'электротехнического персонала',
    kk: 'электротехникалық персонал',
  },
  electrotechnological: {
    label: 'Электротехнологический персонал',
    ru: 'электротехнологического персонала',
    kk: 'электротехнологиялық персонал',
  },
  administrative: {
    label: 'Административно-технический персонал',
    ru: 'административно-технического персонала',
    kk: 'әкімшілік-техникалық персонал',
  },
  operational: {
    label: 'Оперативный персонал',
    ru: 'оперативного персонала',
    kk: 'жедел персонал',
  },
  maintenance: {
    label: 'Ремонтный персонал',
    ru: 'ремонтного персонала',
    kk: 'жөндеу персоналы',
  },
};

function isGroup(value: unknown): value is ElectricalGroup {
  return ELECTRICAL_GROUPS.includes(value as ElectricalGroup);
}
function isVoltage(value: unknown): value is ElectricalVoltage {
  return ELECTRICAL_VOLTAGES.includes(value as ElectricalVoltage);
}
function isRole(value: unknown): value is ElectricalRole {
  return ELECTRICAL_ROLES.includes(value as ElectricalRole);
}

/** The course's admission, with anything it does not state taken from the form. */
export function courseAdmission(
  stored: Partial<ElectricalAdmission> | null | undefined,
): ElectricalAdmission {
  return {
    group: isGroup(stored?.group) ? stored.group : ELECTRICAL_DEFAULT.group,
    voltage: isVoltage(stored?.voltage) ? stored.voltage : ELECTRICAL_DEFAULT.voltage,
    role: isRole(stored?.role) ? stored.role : ELECTRICAL_DEFAULT.role,
    ...(isJournalStart(stored?.journalStart) ? { journalStart: stored.journalStart } : {}),
  };
}

/** The admission of one person: their own group and voltage, else the course's. */
export function personAdmission(
  course: Partial<ElectricalAdmission> | null | undefined,
  person: { electricalGroup?: string; electricalVoltage?: string } | null | undefined,
): ElectricalAdmission {
  const admission = courseAdmission(course);
  return {
    group: isGroup(person?.electricalGroup) ? person.electricalGroup : admission.group,
    voltage: isVoltage(person?.electricalVoltage) ? person.electricalVoltage : admission.voltage,
    role: admission.role,
  };
}

/** «II группа до 1000 В» — the way the protocol and the booklet name it. */
export function electricalGroupText(admission: ElectricalAdmission) {
  return `${admission.group} группа ${ELECTRICAL_VOLTAGE_TEXT[admission.voltage].ru}`;
}
/** «Допущен к работе в электроустановках до 1000 В, в качестве электротехнического персонала». */
export function electricalAdmissionText(admission: ElectricalAdmission) {
  return (
    `Допущен к работе в электроустановках ${ELECTRICAL_VOLTAGE_TEXT[admission.voltage].ru}, ` +
    `в качестве ${ELECTRICAL_ROLE_TEXT[admission.role].ru}`
  );
}
