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
    const body = (await readJsonBody(request)) as Record<string, unknown> | null;
    if (
      !body ||
      typeof body.phone !== 'string' ||
      typeof body.whatsapp !== 'string' ||
      typeof body.whatsappSameAsPhone !== 'boolean' ||
      typeof body.expectedVersion !== 'number'
    ) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await requireCapability('site.settings.manage');
    await consumeAdminMutationQuota(
      'site.settings.update',
      requestSecurityMetadata(request).ipHash,
    );

    const settings = await updateSiteContacts({
      phone: body.phone,
      whatsapp: body.whatsapp,
      whatsappSameAsPhone: body.whatsappSameAsPhone,
      expectedVersion: body.expectedVersion,
    });
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
