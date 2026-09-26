import type { Metadata } from 'next';
import { NotFoundNotice } from '@/components/shared/not-found-notice';
import { resolveSiteOrigin } from '@/lib/site-url';
import { THEME_BOOTSTRAP } from '@/lib/theme';
import './globals.css';

/**
 * The not-found convention resolves last and overrides the layouts above it.
 * Without these fields a 404 inherited the public layout's canonical — so it
 * declared itself to be «/» — and its `robots: index, follow`. That happens
 * wherever the page itself never runs: unmatched URLs and unknown locales.
 */
export const metadata: Metadata = {
  metadataBase: new URL(resolveSiteOrigin()),
  // The document cannot know its visitor's language on the server (the notice
  // picks it from the URL in the browser), so the tab title is language-free.
  title: '404 — SafetyHub',
  robots: { index: false, follow: false },
  alternates: { canonical: null },
};

/**
 * The root 404 renders outside every root layout — the app has four, one per
 * audience — so it owns its document. It used to return a bare fragment, and
 * Next answered with its own error shell: no stylesheet, no `lang`, no title,
 * and the text only appeared once JavaScript ran. Every group that calls
 * `notFound()` inside its own layout has its own not-found file, so this one
 * never nests inside another `<html>`.
 */
export default function NotFound() {
  return (
    <html lang="ru" data-locale="ru" suppressHydrationWarning>
      <body className="bg-[var(--color-bg)] text-[var(--color-text)] antialiased">
        <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        <main id="main-content">
          <NotFoundNotice />
        </main>
      </body>
    </html>
  );
}
