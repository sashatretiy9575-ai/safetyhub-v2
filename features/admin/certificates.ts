import 'server-only';

import { requireCapability } from '@/features/auth/server';
import { invalidateCertificateVerificationCache } from '@/features/certificates/server';
import { createClient } from '@/lib/supabase/server';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';

export async function revokeCertificate(certificateId: string, reason: string): Promise<void> {
  await requireCapability('certificate.revoke');
  const supabase = await createClient();
  const response = await supabase.rpc('revoke_certificate', {
    p_certificate_id: certificateId,
    p_reason: reason,
  });
  unwrapRpcMutationResponse(response);
  invalidateCertificateVerificationCache();
}
