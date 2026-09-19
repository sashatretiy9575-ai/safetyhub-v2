import type { AdminAttestationRow } from './types';

/** An improved result can await a replacement while its old certificate remains valid. */
export function attestationNeedsIssuance(
  row: Pick<
    AdminAttestationRow,
    'courseDeleted' | 'certificateState' | 'identityState' | 'scoreImproved'
  >,
): boolean {
  return (
    !row.courseDeleted &&
    (row.certificateState === 'ready' ||
      row.certificateState === 'revoked' ||
      (row.certificateState === 'issued' && row.identityState === 'verified' && row.scoreImproved))
  );
}
