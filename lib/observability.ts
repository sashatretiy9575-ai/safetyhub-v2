export function reportAppError(error: unknown, context: Record<string, unknown> = {}) {
  const correlationId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const development = process.env.NODE_ENV !== 'production';
  const safeContext = Object.fromEntries(
    Object.entries(context)
      .slice(0, 12)
      .map(([key, value]) => [
        key.slice(0, 64),
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
          ? String(value).slice(0, 128)
          : null,
      ]),
  );
  const payload = {
    correlationId,
    message: development ? (error instanceof Error ? error.message : String(error)) : 'REDACTED',
    stack: development && error instanceof Error ? error.stack : undefined,
    context: safeContext,
    timestamp: new Date().toISOString(),
  };

  if (typeof window !== 'undefined') {
    console.error(
      '[app-error]',
      development
        ? payload
        : { correlationId: payload.correlationId, context: safeContext, timestamp: payload.timestamp },
    );
  }

  if (development) {
    console.info('[app-error-correlation]', correlationId);
  }

  return payload;
}
