import type { AnchorHTMLAttributes, ReactNode } from 'react';
import {
  contactPhoneHref,
  contactWhatsappHref,
  type SiteContactSettings,
} from '@/lib/site-contacts-shared';

type ContactLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  kind: 'phone' | 'whatsapp';
  contacts: SiteContactSettings;
  children: ReactNode;
};

export function ContactLink({ kind, contacts, children, ...props }: ContactLinkProps) {
  const external = kind === 'whatsapp';
  return (
    <a
      {...props}
      href={kind === 'phone' ? contactPhoneHref(contacts) : contactWhatsappHref(contacts)}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {children}
    </a>
  );
}
