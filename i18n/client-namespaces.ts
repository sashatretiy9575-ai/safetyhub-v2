import type { AbstractIntlMessages } from 'next-intl';

/**
 * The namespaces a client component may ask for.
 *
 * The whole catalog used to be serialised into the RSC payload of every page —
 * about 34 KB of JSON per request — although seven of its namespaces are only
 * ever read on the server, where `getTranslations` reads the catalog directly
 * and never needs it in the document.
 *
 * A namespace missing here is a runtime error, not a silent fallback, so
 * `tests/i18n/client-namespaces.test.mjs` recomputes this list from the source
 * and fails if a client component starts using one that is not in it.
 */
export const CLIENT_NAMESPACES = [
  'AccountDeletion',
  'AppState',
  'Approval',
  'AuthOtp',
  'AuthZh',
  'Avatar',
  'Certificate',
  'Common',
  'Course',
  'LegalFlow',
  'Profile',
  'Pwa',
  'PwaManual',
  'Quiz',
  'Shell',
] as const;

export function pickClientNamespaces(messages: AbstractIntlMessages): AbstractIntlMessages {
  const picked: Record<string, unknown> = {};
  for (const namespace of CLIENT_NAMESPACES) {
    if (namespace in messages) picked[namespace] = messages[namespace];
  }
  return picked as AbstractIntlMessages;
}
