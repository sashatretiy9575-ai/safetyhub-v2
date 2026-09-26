import { NotFoundNotice } from '@/components/shared/not-found-notice';

/**
 * 404 inside the private root layout (an unknown course test, a login link for
 * a locale that is switched off). Without it the root not-found — which owns a
 * whole document — would be drawn inside this layout's `<body>`.
 */
export default function AccountNotFound() {
  return <NotFoundNotice />;
}
