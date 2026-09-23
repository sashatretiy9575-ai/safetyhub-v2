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

/**
 * What the public site's client components read: the shell, the install
 * prompt, the course material buttons. The rest — the quiz, the profile, sign
 * in — belongs to the account and admin roots; sent with every public page it
 * was about 25 KB of JSON nobody on that page could use.
 */
export const PUBLIC_CLIENT_NAMESPACES = [
  'AppState',
  'Common',
  'Course',
  'Pwa',
  'PwaManual',
  'Shell',
] as const satisfies readonly (typeof CLIENT_NAMESPACES)[number][];

export function pickClientNamespaces(
  messages: AbstractIntlMessages,
  namespaces: readonly string[] = CLIENT_NAMESPACES,
): AbstractIntlMessages {
  const picked: Record<string, unknown> = {};
  for (const namespace of namespaces) {
    if (namespace in messages) picked[namespace] = messages[namespace];
  }
  return picked as AbstractIntlMessages;
}
