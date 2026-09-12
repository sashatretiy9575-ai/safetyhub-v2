import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { requireCapability } from '@/features/auth/server';
import {
  CertificateSettingsConflictError,
  certificateSettingsPatchSchema,
  readCertificateSettings,
  updateCertificateSettings,
} from '@/features/certificates/settings';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';
import { readJsonBody } from '@/lib/security/request-body';

// Three PNGs of up to 400 KB each travel as base64 in one request.
const PATCH_BODY_LIMIT = 2 * 1024 * 1024;

export async function GET() {
  try {
    await requireCapability('site.settings.manage');
    return NextResponse.json({ settings: await readCertificateSettings() });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    // Authorization precedes parsing: an unauthenticated caller must not get a
    // request body read and validated on the product's budget.
    await requireCapability('site.settings.manage');
    await consumeAdminMutationQuota(
      'site.settings.update',
      requestSecurityMetadata(request).ipHash,
    );

    const parsed = certificateSettingsPatchSchema.safeParse(
      await readJsonBody(request, PATCH_BODY_LIMIT),
    );
    if (!parsed.success) {
      const imageIssue = parsed.error.issues.find(
        (issue) => issue.message === 'CERTIFICATE_IMAGE_INVALID',
      );
      return NextResponse.json(
        { error: imageIssue ? 'CERTIFICATE_IMAGE_INVALID' : 'INVALID_REQUEST' },
        { status: 400 },
      );
    }

    const settings = await updateCertificateSettings(parsed.data);
    return NextResponse.json({ settings });
  } catch (error) {
    if (error instanceof CertificateSettingsConflictError) {
      return NextResponse.json(
        { error: error.message, settings: await readCertificateSettings() },
        { status: 409 },
      );
    }
    return apiError(error);
  }
}
