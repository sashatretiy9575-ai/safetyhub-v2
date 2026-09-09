import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';
import { Container } from '@/components/ui/container';
import { DEFAULT_LOCALE } from '@/i18n/config';

/**
 * 404 for the unprefixed Russian public tree, so a missing course or article
 * keeps the header, the footer and the language of the page it was reached
 * from. The locale is explicit: this file must stay statically renderable.
 */
export default async function PublicNotFound() {
  const [state, common] = await Promise.all([
    getTranslations({ locale: DEFAULT_LOCALE, namespace: 'AppState' }),
    getTranslations({ locale: DEFAULT_LOCALE, namespace: 'Common' }),
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
          <Link href="/">{common('home')}</Link>
        </Button>
      </div>
    </Container>
  );
}
