import { ROUTES } from '@/lib/constants';

export const PRIMARY_NAV_ITEMS = [
  { href: ROUTES.home, messageKey: 'nav.home' },
  { href: ROUTES.topics, messageKey: 'nav.topics' },
  { href: ROUTES.blog, messageKey: 'nav.blog' },
  { href: ROUTES.contacts, messageKey: 'nav.contacts' },
] as const;

export type AccountMode = 'authenticated' | 'guest' | 'neutral';

export const ACCOUNT_NAV_ITEMS = {
  neutral: { href: ROUTES.profile, messageKey: 'account.neutral' },
  guest: { href: ROUTES.signIn, messageKey: 'account.guest' },
  authenticated: {
    href: ROUTES.profile,
    messageKey: 'account.authenticated',
  },
} as const satisfies Record<AccountMode, { href: string; messageKey: `account.${AccountMode}` }>;
