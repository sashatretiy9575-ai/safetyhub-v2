'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { reportAppError } from '@/lib/observability';
import { htmlLanguage, localizePathname, type AppLocale } from '@/i18n/config';
import { emergencyLocale } from '@/i18n/emergency-locale';
import ruMessages from '@/messages/global-error/ru.json';
import kkMessages from '@/messages/global-error/kk.json';
import enMessages from '@/messages/global-error/en.json';
import zhMessages from '@/messages/global-error/zh.json';

const MESSAGE_CATALOGS = {
  ru: ruMessages,
  kk: kkMessages,
  en: enMessages,
  zh: zhMessages,
} as const;

// `global-error` replaces every root layout, so no stylesheet reaches it: the
// Tailwind classes it used rendered as unstyled Times New Roman. It is drawn
// with style attributes instead — allowed by every page's CSP — in the light
// theme's colours from app/globals.css.
const button: CSSProperties = {
  minHeight: 44,
  padding: '0 24px',
  borderRadius: 12,
  font: 'inherit',
  fontSize: '0.875rem',
  fontWeight: 600,
  display: 'inline-flex',
  alignItems: 'center',
  cursor: 'pointer',
  textDecoration: 'none',
};
const styles = {
  body: {
    margin: 0,
    minHeight: '100dvh',
    display: 'grid',
    placeItems: 'center',
    padding: 24,
    boxSizing: 'border-box',
    background: '#f7f8fa',
    color: '#171a1f',
    fontFamily: 'Manrope, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  },
  card: {
    width: '100%',
    maxWidth: '36rem',
    boxSizing: 'border-box',
    padding: 24,
    borderRadius: 24,
    border: '1px solid #f3b8b3',
    background: '#ffffff',
    textAlign: 'center',
  },
  title: { margin: '0 0 8px', fontSize: '1.5rem', lineHeight: 1.25, fontWeight: 700 },
  text: { margin: '0 0 8px', fontSize: '0.875rem', lineHeight: 1.5, color: '#59616b' },
  code: {
    margin: '0 0 4px',
    fontFamily: 'ui-monospace, monospace',
    fontSize: '0.75rem',
    color: '#59616b',
    wordBreak: 'break-all',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 12,
    marginTop: 20,
  },
  primary: { ...button, border: 0, background: '#176b43', color: '#ffffff' },
  outline: { ...button, border: '1px solid #c5cbd3', background: 'transparent', color: '#171a1f' },
} satisfies Record<string, CSSProperties>;

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Reported once per mount, not on every render.
  const [diagnostic] = useState(() =>
    reportAppError(error, { source: 'global-error', digest: error.digest }),
  );
  const [locale, setLocale] = useState<AppLocale>('ru');
  const messages = MESSAGE_CATALOGS[locale];

  useEffect(() => setLocale(emergencyLocale()), []);

  return (
    <html lang={htmlLanguage(locale)} style={{ colorScheme: 'light' }}>
      <body style={styles.body}>
        <title>{messages.AppState.criticalTitle}</title>
        <main role="alert" style={styles.card}>
          <h1 style={styles.title}>{messages.AppState.criticalTitle}</h1>
          <p style={styles.text}>{messages.AppState.criticalDescription}</p>
          <p style={styles.code}>
            {messages.Common.correlationIdPlain}: {diagnostic.correlationId}
          </p>
          {error.digest ? (
            <p style={styles.code}>
              {messages.AppState.digestId}: {error.digest}
            </p>
          ) : null}
          <div style={styles.actions}>
            <button type="button" onClick={reset} style={styles.primary}>
              {messages.Common.retry}
            </button>
            <a href={localizePathname('/', locale)} style={styles.outline}>
              {messages.Common.home}
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
