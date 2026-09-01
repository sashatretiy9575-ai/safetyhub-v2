'use client';

import { useRouter } from 'next/navigation';
import { LegalAcceptancePanel } from '@/features/profile/legal-acceptance-panel';
import type { LegalDocumentVersion } from '@/lib/legal';

/**
 * Legal consent is a separate authenticated action after OTP verification.
 * It deliberately does not trust registration mode or a browser-stored flag.
 */
export function LegalAcceptanceGate({
  continueTo,
  currentPolicies,
}: {
  continueTo: string;
  currentPolicies: Readonly<{
    privacy: LegalDocumentVersion;
    terms: LegalDocumentVersion;
  }>;
}) {
  const router = useRouter();

  return (
    <LegalAcceptancePanel
      initialAcceptances={[]}
      initiallyUnavailable={false}
      currentPolicies={currentPolicies}
      onAccepted={() => {
        router.replace(continueTo);
        router.refresh();
      }}
    />
  );
}
