/** Audit filters and labels share Kazakhstan time (UTC+5), independent of the server. */
export const AUDIT_TIME_ZONE = 'Etc/GMT-5';
const OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function auditDateValue(instant: string | Date) {
  const date = new Date(instant);
  return Number.isNaN(date.getTime())
    ? ''
    : new Date(date.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

export function auditDateBoundary(value: string | undefined, exclusiveEnd = false) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return new Date(date.getTime() - OFFSET_MS + (exclusiveEnd ? DAY_MS : 0)).toISOString();
}

export function auditInclusiveEndValue(exclusiveEnd: string) {
  return auditDateValue(new Date(new Date(exclusiveEnd).getTime() - 1));
}

export function auditRecentPeriod(days: number, now = new Date()) {
  const to = auditDateValue(now);
  const start = auditDateBoundary(to)!;
  return { from: auditDateValue(new Date(new Date(start).getTime() - (days - 1) * DAY_MS)), to };
}

/** Day counts behind the «Сегодня / 7 дней / 30 дней» shortcuts. */
export const AUDIT_QUICK_PERIODS = [1, 7, 30] as const;

/**
 * The shortcut whose dates the filter currently carries, so the page can mark
 * it as applied. Both ends have to match: a hand-picked range that merely
 * starts or ends on the same day is not a shortcut.
 */
export function auditActivePeriod(from: string, to: string, now = new Date()) {
  return (
    AUDIT_QUICK_PERIODS.find((days) => {
      const period = auditRecentPeriod(days, now);
      return period.from === from && period.to === to;
    }) ?? null
  );
}
