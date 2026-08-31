import { NextResponse } from '@/lib/security/api-response';
import { inviteUserSchema } from '@/lib/validation/admin';
import { inviteUser } from '@/features/admin/server';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { readJsonBody } from '@/lib/security/request-body';

export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const parsed = inviteUserSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    const id = await inviteUser(
      parsed.data,
      requestSecurityMetadata(request),
    );
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) { return apiError(error); }
}
