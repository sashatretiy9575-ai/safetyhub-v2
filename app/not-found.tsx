import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Container } from '@/components/ui/container';
import { Button } from '@/components/ui/button';
import { localizePathname, type AppLocale } from '@/i18n/config';

export default async function NotFound() {
  const [locale, t, common] = await Promise.all([
    getLocale() as Promise<AppLocale>,
    getTranslations('AppState'),
    getTranslations('Common'),
  ]);
  return (
    <Container size="narrow" className="grid min-h-[60vh] place-items-center py-16 text-center">
      <div className="space-y-4">
        <p className="font-mono text-sm uppercase tracking-widest text-[var(--color-text-muted)]">404</p>
        <h1 className="font-display text-3xl font-semibold">{t('notFoundTitle')}</h1>
        <p className="text-[var(--color-text-muted)]">{t('notFoundDescription')}</p>
        <Button asChild>
          <Link href={localizePathname('/', locale)}>{common('home')}</Link>
        </Button>
      </div>
    </Container>
  );
}
