import 'server-only';

import { after } from 'next/server';

/**
 * Runs work after the response has been sent while keeping the serverless
 * function alive. Route handlers import this facade instead of `next/server`
 * so the API response-boundary contract stays enforceable by tests.
 */
export function afterResponse(task: () => void | Promise<void>) {
  after(task);
}
