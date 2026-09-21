import { PhoneCall, WhatsappLogo } from '@phosphor-icons/react/dist/ssr';
import { ContactLink } from '@/components/shared/contact-link';
import { Button } from '@/components/ui/button';
import type { SiteContactSettings } from '@/lib/site-contacts';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';

/**
 * Two buttons of one shape and one radius. They used to be tiles: a bordered
 * card with a bordered circle inside it, each with its own corner, which the
 * owner reads as a frame inside a frame rather than as something to press.
 */
export function ContactActions({
  contacts,
  compact = false,
}: {
  contacts: SiteContactSettings;
  compact?: boolean;
}) {
  const t = useTranslations('Contacts');
  return (
    <div className={cn('grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2', compact ? '' : 'w-full')}>
      <Button
        asChild
        variant="secondary"
        size="xl"
        className="min-h-14 min-w-0 px-4 [&_svg]:size-5"
      >
        {/* The icon already says «call» and «chat»: the buttons show the number and
            the messenger alone, and only a screen reader hears the verb. */}
        <ContactLink kind="phone" contacts={contacts}>
          <PhoneCall weight="bold" aria-hidden="true" className="text-[var(--color-primary)]" />
          <span className="min-w-0 whitespace-nowrap">
            <span className="sr-only">{t('call')} </span>
            {contacts.phoneDisplay}
          </span>
        </ContactLink>
      </Button>

      <Button asChild variant="primary" size="xl" className="min-h-14 min-w-0 px-4 [&_svg]:size-5">
        <ContactLink kind="whatsapp" contacts={contacts}>
          <WhatsappLogo weight="fill" aria-hidden="true" />
          <span className="min-w-0">
            <span className="sr-only">{t('chatAction')}</span>
            <span aria-hidden="true">WhatsApp</span>
          </span>
        </ContactLink>
      </Button>
    </div>
  );
}
