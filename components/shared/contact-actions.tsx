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
    <div className={cn('grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2', compact ? '' : 'w-full')}>
      <ContactLink
        kind="phone"
        contacts={contacts}
        className="group flex min-h-14 min-w-0 items-center justify-start gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left text-[var(--color-text)] shadow-[var(--shadow-soft)] transition-colors hover:border-[var(--color-primary)]/50 hover:bg-[var(--color-surface-muted)] focus-visible:outline-[3px] focus-visible:outline-offset-3 focus-visible:outline-[var(--color-focus)] sm:min-h-16 sm:p-4"
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-[var(--color-primary)]/20 bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
          <PhoneCall size={20} weight="bold" aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
            {t('call')}
          </span>
          <span className="mt-0.5 block truncate text-base font-bold text-[var(--color-text)]">
            {contacts.phoneDisplay}
          </span>
        </span>
      </ContactLink>

      <ContactLink
        kind="whatsapp"
        contacts={contacts}
        className="group flex min-h-14 min-w-0 items-center justify-start gap-3 rounded-2xl border border-[var(--color-primary)]/40 bg-[var(--color-primary-soft)]/40 px-3 py-2 text-left text-[var(--color-text)] shadow-[var(--shadow-soft)] transition-colors hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-soft)] focus-visible:outline-[3px] focus-visible:outline-offset-3 focus-visible:outline-[var(--color-focus)] sm:min-h-16 sm:p-4"
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--color-primary)] text-white">
          <WhatsappLogo size={22} weight="fill" aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block text-base font-bold text-[var(--color-text)] leading-tight">
            WhatsApp
          </span>
          <span className="mt-0.5 block truncate text-xs font-medium text-[var(--color-text-muted)]">
            {t('chat')}
          </span>
        </span>
      </ContactLink>
    </div>
  );
}
