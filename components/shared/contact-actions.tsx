import { PhoneCall, WhatsappLogo } from '@phosphor-icons/react/dist/ssr';
import { ContactLink } from '@/components/shared/contact-link';
import type { SiteContactSettings } from '@/lib/site-contacts-shared';
import { cn } from '@/lib/utils';

export function ContactActions({
  contacts,
  compact = false,
}: {
  contacts: SiteContactSettings;
  compact?: boolean;
}) {
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
          <span className="block text-[13px] leading-4 font-bold">Позвонить</span>
          <span className="mt-0.5 block truncate text-[15px] leading-5 font-semibold text-[var(--color-text-subtle)]">
            {contacts.phoneDisplay}
          </span>
        </span>
      </ContactLink>

      <ContactLink
        kind="whatsapp"
        contacts={contacts}
        className="group inline-flex min-h-14 min-w-0 items-center justify-start gap-2.5 overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)]/72 px-3 text-left text-[var(--color-text)] shadow-[var(--shadow-soft)] backdrop-blur-xl transition hover:border-[#128c4a]/45 hover:bg-[var(--color-surface)] focus-visible:outline-[3px] focus-visible:outline-offset-3 focus-visible:outline-[var(--color-focus)] sm:min-h-[60px] sm:px-4"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-[12px] border border-[#128c4a]/35 bg-[#128c4a]/12 text-[#128c4a] dark:bg-[#25d366]/12 dark:text-[#39dc7a]">
          <WhatsappLogo size={20} weight="regular" aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block text-[15px] leading-5 font-bold">WhatsApp</span>
          <span className="mt-0.5 block truncate text-[15px] leading-5 font-medium text-[var(--color-text-subtle)]">
            Ответим в чате
          </span>
        </span>
      </ContactLink>
    </div>
  );
}
