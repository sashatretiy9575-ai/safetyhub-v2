import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  contactPhoneHref,
  contactWhatsappHref,
  type SiteContactSettings,
} from '@/lib/site-contacts';

type ContactLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  kind: 'phone' | 'whatsapp';
  contacts: SiteContactSettings;
  children: ReactNode;
};

export function ContactLink({ kind, contacts, children, ...props }: ContactLinkProps) {
  const t = useTranslations('Common');
  const external = kind === 'whatsapp';
  // WhatsApp opens in a new tab, which a screen reader user is told about. A
  // link named by `aria-label` gets the words in the label, since the label
  // replaces the content; any other link gets them as hidden text inside it.
  const label = props['aria-label'];
  const newTab = t('opensInNewTab');
  return (
    <a
      {...props}
      href={kind === 'phone' ? contactPhoneHref(contacts) : contactWhatsappHref(contacts)}
      {...(external
        ? {
            target: '_blank',
            rel: 'noopener noreferrer',
            ...(label ? { 'aria-label': `${label} ${newTab}` } : {}),
          }
        : {})}
    >
      {children}
      {external && !label ? <span className="sr-only"> {newTab}</span> : null}
    </a>
  );
}
