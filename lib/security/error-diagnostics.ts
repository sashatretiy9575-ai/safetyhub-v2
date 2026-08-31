const SAFE_DIAGNOSTIC_CODE = /^[A-Z0-9_]{2,32}$/u;

export function safeErrorDiagnosticCode(error: unknown, fallback: string) {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    const code = error.code.toUpperCase();
    if (SAFE_DIAGNOSTIC_CODE.test(code)) return code;
  }
  if (error instanceof Error) {
    const prefix = /^([A-Z0-9_]{2,32})(?::|$)/u.exec(error.message)?.[1];
    if (prefix && SAFE_DIAGNOSTIC_CODE.test(prefix)) return prefix;
  }
  return fallback;
}
