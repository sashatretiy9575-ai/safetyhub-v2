import { legalBundlePublicationSchema } from '@/features/admin/localization-contract';
import { publishLegalLocalizationBundle } from '@/features/admin/localizations-server';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { requireCapability } from '@/features/auth/server';
import { NextResponse } from '@/lib/security/api-response';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';

const bundleConflictErrors = new Set([
  'LEGAL_BUNDLE_LOCALIZATIONS_INCOMPLETE',
  'LEGAL_BUNDLE_MIXED_STATE',
  'LEGAL_BUNDLE_EFFECTIVE_AT_MISMATCH',
]);

export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const parsed = legalBundlePublicationSchema.safeParse(await readJsonBody(request, 4 * 1024));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await requireCapability('content.manage');
    await consumeAdminMutationQuota(
      'content.article.mutate',
      requestSecurityMetadata(request).ipHash,
    );
    return NextResponse.json(
      await publishLegalLocalizationBundle(parsed.data.privacyVersion, parsed.data.termsVersion),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const conflict = [...bundleConflictErrors].find((code) => message.includes(code));
    if (conflict) return NextResponse.json({ error: conflict }, { status: 409 });
    return apiError(error);
  }
}
