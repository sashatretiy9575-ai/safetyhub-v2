import { PhoneCall, WhatsappLogo } from '@phosphor-icons/react/dist/ssr';
import { ContactLink } from '@/components/shared/contact-link';
import type { SiteContactSettings } from '@/lib/site-contacts-shared';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';

export function ContactActions({
  contacts,
  compact = false,
}: {
  contacts: SiteContactSettings;
  compact?: boolean;
}) {
  const t = useTranslations('Contacts');
  return (
    <div className={cn('grid min-w-0 grid-cols-1 gap-2.5 sm:grid-cols-2', compact ? '' : 'w-full')}>
      <ContactLink
        kind="phone"
        contacts={contacts}
        className="group inline-flex min-h-14 min-w-0 items-center justify-start gap-2.5 overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)]/72 px-3 text-left text-[var(--color-text)] shadow-[var(--shadow-soft)] backdrop-blur-xl transition hover:border-[var(--color-primary)]/40 hover:bg-[var(--color-surface)] focus-visible:outline-[3px] focus-visible:outline-offset-3 focus-visible:outline-[var(--color-focus)] sm:min-h-[60px] sm:px-4"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-[12px] border border-[var(--color-primary)]/20 bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
          <PhoneCall size={20} weight="regular" aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block text-[13px] leading-4 font-bold">{t('call')}</span>
          <span className="mt-0.5 block truncate text-[15px] leading-5 font-semibold text-[var(--color-text-subtle)]">
            {contacts.phoneDisplay}
          </span>
        </span>
      </ContactLink>

      <ContactLink
        kind="whatsapp"
        contacts={contacts}
        className="group inline-flex min-h-14 min-w-0 items-center justify-start gap-2.5 overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-primary)]/45 bg-[var(--color-primary-soft)]/55 px-3 text-left text-[var(--color-text)] shadow-[var(--shadow-soft)] transition hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-soft)] focus-visible:outline-[3px] focus-visible:outline-offset-3 focus-visible:outline-[var(--color-focus)] sm:min-h-[60px] sm:px-4"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-[12px] border border-[var(--color-primary)]/35 bg-[var(--color-surface)]/60 text-[var(--color-primary)]">
          <WhatsappLogo size={20} weight="regular" aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block text-[15px] leading-5 font-bold">WhatsApp</span>
          <span className="mt-0.5 block truncate text-[15px] leading-5 font-medium text-[var(--color-text-muted)]">
            {t('chat')}
          </span>
        </span>
      </ContactLink>
    </div>
  );
}
