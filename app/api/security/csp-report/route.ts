import { createApiResponse } from '@/lib/security/api-response';
import { readBoundedText } from '@/lib/security/request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REPORT_MAX_BYTES = 16 * 1024;

/**
 * Browsers send a burst of identical reports when a policy blocks something on
 * a popular page. Collapsing them per directive keeps a real regression visible
 * without turning the platform log into the attack surface.
 */
const LOG_WINDOW_MS = 60_000;
const LOG_BUDGET_PER_WINDOW = 20;
let windowStartedAt = 0;
let loggedInWindow = 0;

function mayLog() {
  const now = Date.now();
  if (now - windowStartedAt > LOG_WINDOW_MS) {
    windowStartedAt = now;
    loggedInWindow = 0;
  }
  if (loggedInWindow >= LOG_BUDGET_PER_WINDOW) return false;
  loggedInWindow += 1;
  return true;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, maximum = 120) {
  return typeof value === 'string' ? value.slice(0, maximum) : null;
}

/**
 * Reduces a report to the two fields that identify a policy problem. The
 * document URL, the sample and the script contents are deliberately dropped:
 * they can carry a one-time code or a participant's data.
 */
function summarize(payload: unknown): string | null {
  const bodies: unknown[] = [];
  if (Array.isArray(payload)) {
    // `report-to` delivers a batch of { type, body } envelopes.
    for (const entry of payload) bodies.push(record(entry)?.body);
  } else {
    // `report-uri` delivers a single { "csp-report": … } object.
    bodies.push(record(payload)?.['csp-report'] ?? payload);
  }

  for (const candidate of bodies) {
    const body = record(candidate);
    if (!body) continue;
    const directive =
      text(body.effectiveDirective) ??
      text(body['effective-directive']) ??
      text(body.violatedDirective) ??
      text(body['violated-directive']);
    if (!directive) continue;
    const blocked = text(body.blockedURL) ?? text(body['blocked-uri']);
    let origin = 'unknown';
    if (blocked) {
      try {
        origin = new URL(blocked).origin;
      } catch {
        // `inline`, `eval` and `data` arrive as bare keywords rather than URLs.
        origin = blocked.slice(0, 32);
      }
    }
    return `${directive} blocked ${origin}`;
  }
  return null;
}

/**
 * Collects Content-Security-Policy violation reports so the public policy can
 * be tightened on evidence instead of guesswork. It stores nothing and touches
 * no database: a reporting endpoint that writes rows is an amplifier any
 * anonymous visitor can aim at the product.
 */
export async function POST(request: Request) {
  let body: string;
  try {
    body = await readBoundedText(request, REPORT_MAX_BYTES);
  } catch {
    return createApiResponse(null, { status: 204 });
  }

  try {
    const summary = summarize(JSON.parse(body));
    if (summary && mayLog()) process.stderr.write(`csp-report: ${summary}\n`);
  } catch {
    // A malformed report is not worth a log line, let alone an error response.
  }

  return createApiResponse(null, { status: 204 });
}
