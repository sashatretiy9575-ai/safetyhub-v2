import { ROUTES } from '@/lib/constants';

export const PRIMARY_NAV_ITEMS = [
  { href: ROUTES.home, label: 'Главная' },
  { href: ROUTES.topics, label: 'Курсы' },
  { href: ROUTES.blog, label: 'Блог' },
  { href: ROUTES.contacts, label: 'Контакты' },
] as const;

export type AccountMode = 'authenticated' | 'guest' | 'neutral';

export const ACCOUNT_NAV_ITEMS = {
  neutral: { href: ROUTES.profile, label: 'Аккаунт' },
  guest: { href: ROUTES.signIn, label: 'Войти' },
  authenticated: { href: ROUTES.profile, label: 'Профиль' },
} as const satisfies Record<AccountMode, { href: string; label: string }>;
