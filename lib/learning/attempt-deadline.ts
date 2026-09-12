export function deadlineAnchorFromServer(
  expiresAt: string,
  serverNow: string,
  monotonicNow: number,
) {
  const expires = Date.parse(expiresAt);
  const server = Date.parse(serverNow);
  if (!Number.isFinite(expires) || !Number.isFinite(server) || !Number.isFinite(monotonicNow)) {
    return null;
  }
  return monotonicNow + Math.max(0, expires - server);
}

export function remainingDeadlineSeconds(deadlineAnchor: number | null, monotonicNow: number) {
  if (deadlineAnchor === null || !Number.isFinite(monotonicNow)) return null;
  return Math.max(0, Math.ceil((deadlineAnchor - monotonicNow) / 1_000));
}

export function formatDeadlineSeconds(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}
