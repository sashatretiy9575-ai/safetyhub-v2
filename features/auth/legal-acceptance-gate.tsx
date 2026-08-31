'use client';

import { useRouter } from 'next/navigation';
import { LegalAcceptancePanel } from '@/features/profile/legal-acceptance-panel';

/**
 * Legal consent is a separate authenticated action after OTP verification.
 * It deliberately does not trust registration mode or a browser-stored flag.
 */
export function LegalAcceptanceGate({ continueTo }: { continueTo: '/admin' | '/onboarding' | '/profile' }) {
  const router = useRouter();

  return (
    <LegalAcceptancePanel
      initialAcceptances={[]}
      initiallyUnavailable={false}
      onAccepted={() => {
        router.replace(continueTo);
        router.refresh();
      }}
    />
  );
}
