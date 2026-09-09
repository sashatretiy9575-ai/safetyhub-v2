import type { Metadata } from 'next';
import { NotFoundNotice } from '@/components/shared/not-found-notice';

/**
 * The not-found convention resolves last and overrides the layouts above it.
 * Without these two fields a 404 inherited the public layout's canonical — so
 * it declared itself to be «/» — and its `robots: index, follow`. That happens
 * wherever the page itself never runs: unmatched URLs, and every prefixed route
 * under `dynamicParams = false`.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  alternates: { canonical: null },
};

/** Root 404 also sits outside the independent locale layouts. */
export default function NotFound() {
  return <NotFoundNotice />;
}
