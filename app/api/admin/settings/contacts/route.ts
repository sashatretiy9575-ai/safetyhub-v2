import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { requireCapability } from '@/features/auth/server';
import {
  SiteContactsConflictError,
  updateSiteContacts,
} from '@/features/site-settings/server';
import { readSiteContactsUncached } from '@/lib/site-contacts';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';
import { readJsonBody } from '@/lib/security/request-body';
import { siteContactsUpdateSchema } from '@/lib/validation/admin';

export async function GET() {
  try {
    await requireCapability('site.settings.manage');
    return NextResponse.json({ settings: await readSiteContactsUncached() });
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

    const parsed = siteContactsUpdateSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }

    const settings = await updateSiteContacts(parsed.data);
    return NextResponse.json({ settings });
  } catch (error) {
    if (error instanceof SiteContactsConflictError) {
      return NextResponse.json(
        { error: error.message, settings: await readSiteContactsUncached() },
        { status: 409 },
      );
    }
    return apiError(error);
  }
}
