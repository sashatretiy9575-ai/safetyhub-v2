import { useTranslations } from 'next-intl';

/**
 * The spoken half of a link that opens a new tab. A sighted visitor sees the
 * tab appear; a screen reader user was moved into a new browsing context with
 * no warning, and "Back" then did nothing. Put it inside every link with
 * `target="_blank"` that takes its name from its content; a link named by
 * `aria-label` needs `useNewTabLabel` instead, since the label replaces the
 * content.
 *
 * Deliberately not a client component: it renders the same text from a server
 * component and from a client one, and `Common` is sent to every client root.
 */
export function NewTabHint() {
  const t = useTranslations('Common');
  return <span className="sr-only"> {t('opensInNewTab')}</span>;
}

/** `aria-label` for a new-tab link that is named by its label. */
export function useNewTabLabel(label: string) {
  const t = useTranslations('Common');
  return `${label} ${t('opensInNewTab')}`;
}
