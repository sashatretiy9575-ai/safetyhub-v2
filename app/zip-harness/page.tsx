import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ZipHarnessClient } from './zip-harness-client';

/**
 * Internal diagnostic surface for the certificate ZIP export. It exists only to
 * keep the browser archive writer under end-to-end test (the Playwright suite
 * drives it against `next dev`), and must never be reachable from a deployed
 * site: it is neither a product page nor something a visitor should find.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'ZIP harness',
  robots: { index: false, follow: false },
};

function deploymentIsProductionLike() {
  return (
    process.env.VERCEL_ENV === 'production' ||
    process.env.VERCEL_ENV === 'preview' ||
    (process.env.NODE_ENV === 'production' && process.env.PLAYWRIGHT_PORT === undefined)
  );
}

export default function ZipHarnessPage() {
  if (deploymentIsProductionLike()) notFound();
  return <ZipHarnessClient />;
}
