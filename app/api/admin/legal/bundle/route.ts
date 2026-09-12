import { legalBundlePublicationSchema } from '@/lib/admin/localization-contract';
import { publishLegalLocalizationBundle } from '@/server/admin/localizations';
import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { requireCapability } from '@/server/auth/session';
import { NextResponse } from '@/lib/security/api-response';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/server/security/request-metadata';

const bundleConflictErrors = new Set([
  'LEGAL_BUNDLE_LOCALIZATIONS_INCOMPLETE',
  'LEGAL_BUNDLE_MIXED_STATE',
  'LEGAL_BUNDLE_EFFECTIVE_AT_MISMATCH',
]);

export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    await requireCapability('content.manage');
    await consumeAdminMutationQuota(
      'content.article.mutate',
      requestSecurityMetadata(request).ipHash,
    );
    const parsed = legalBundlePublicationSchema.safeParse(await readJsonBody(request, 4 * 1024));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
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
