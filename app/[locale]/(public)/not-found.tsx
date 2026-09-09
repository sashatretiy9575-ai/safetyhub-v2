import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';
import { Container } from '@/components/ui/container';
import { localizePathname, type AppLocale } from '@/i18n/config';

/**
 * 404 for the prefixed public tree. The layout above has already established
 * the locale from the route parameter, so the copy and the home link follow
 * the page the reader was on rather than defaulting to Russian.
 */
export default async function LocalizedPublicNotFound() {
  const [locale, state, common] = await Promise.all([
    getLocale(),
    getTranslations('AppState'),
    getTranslations('Common'),
  ]);

  return (
    <Container size="narrow" className="grid min-h-[60vh] place-items-center py-16 text-center">
      <div className="space-y-4">
        <p className="font-mono text-sm tracking-widest text-[var(--color-text-muted)] uppercase">
          404
        </p>
        <h1 className="font-display text-3xl font-semibold">{state('notFoundTitle')}</h1>
        <p className="text-[var(--color-text-muted)]">{state('notFoundDescription')}</p>
        <Button asChild>
          <Link href={localizePathname('/', locale as AppLocale)}>{common('home')}</Link>
        </Button>
      </div>
    </Container>
  );
}
