import { classifyClientRequestFailure } from '@/lib/client-request';

export type ClientErrorTranslationKey =
  | 'offline'
  | 'timeout'
  | 'network'
  | 'aborted'
  | 'rateLimited'
  | 'temporarilyUnavailable';

type ClientErrorTranslator = (key: ClientErrorTranslationKey) => string;

/**
 * Converts transport state into localized UI copy. API responses remain
 * language-neutral stable codes; no server-provided prose is rendered.
 */
export function localizedClientRequestMessage(
  error: unknown,
  fallback: string,
  translate: ClientErrorTranslator,
) {
  const failure = classifyClientRequestFailure(error);
  switch (failure.kind) {
    case 'offline':
      return translate('offline');
    case 'timeout':
      return translate('timeout');
    case 'network':
      return translate('network');
    case 'aborted':
      return translate('aborted');
    case 'http':
      if (failure.status === 429) return translate('rateLimited');
      if (failure.retryable) return translate('temporarilyUnavailable');
      return fallback;
  }
}
