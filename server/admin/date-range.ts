// Deliberately not marked `server-only`: this is pure date arithmetic with
// nothing privileged in it, and the marker would make the boundary logic
// impossible to test directly — which is how the two copies drifted apart
// unnoticed in the first place.

/**
 * Inclusive start and exclusive end of a calendar day for the administrative
 * date filters.
 *
 * The attestation register and the learning-history reader each carried their
 * own copy of this, behind a boolean flag whose parameter was named `end` in
 * one file and `endExclusive` in the other. They agree today; one edit to
 * either would silently change which rows an operator is shown, in only one of
 * the two places, with nothing to catch it.
 *
 * The boundary is plain UTC midnight, exactly as both copies computed it. It is
 * deliberately not shifted into the business time zone: doing so would move
 * every stored filter by five hours and change which attestations existing
 * bookmarked URLs return.
 */
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

function utcMidnight(value: string | undefined | null) {
  if (!value || !CALENDAR_DAY.test(value)) return null;
  const instant = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/** The first instant of the given day, or null when the input is not a day. */
export function inclusiveRangeStart(value: string | undefined | null) {
  return utcMidnight(value)?.toISOString() ?? null;
}

/** The first instant of the following day, so the range end is exclusive. */
export function exclusiveRangeEnd(value: string | undefined | null) {
  const instant = utcMidnight(value);
  if (!instant) return null;
  instant.setUTCDate(instant.getUTCDate() + 1);
  return instant.toISOString();
}
