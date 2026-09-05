import { NextResponse } from '@/lib/security/api-response';
import { z } from 'zod';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';
import { readJsonBody } from '@/lib/security/request-body';
import { requireCapability } from '@/features/auth/server';
import {
  ADMIN_ATTESTATION_BULK_LIMIT,
  executeAdminAttestationAction,
} from '@/features/admin/attestations';

const ids = z
  .array(z.string().uuid())
  .min(1)
  .max(ADMIN_ATTESTATION_BULK_LIMIT)
  .refine((values) => new Set(values).size === values.length, 'DUPLICATE_TARGET_IDS');
const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm'), userIds: ids, idempotencyKey: z.string().uuid() }),
  z.object({
    action: z.literal('update'),
    userIds: ids,
    field: z.enum(['name', 'surname', 'job', 'organization']),
    value: z.string().trim().min(1).max(200),
    idempotencyKey: z.string().uuid(),
  }),
  z.object({ action: z.literal('issue'), attestationIds: ids, idempotencyKey: z.string().uuid() }),
  z.object({
    action: z.literal('confirm_and_issue'),
    attestationIds: ids,
    idempotencyKey: z.string().uuid(),
  }),
]);

export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const parsed = actionSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    const action = parsed.data;
    if (action.action === 'confirm_and_issue') {
      await requireCapability('certificate.issue');
      await requireCapability('identity.manage');
    } else {
      await requireCapability(action.action === 'issue' ? 'certificate.issue' : 'identity.manage');
    }
    await consumeAdminMutationQuota(
      'admin.attestation.mutate',
      requestSecurityMetadata(request).ipHash,
    );

    const operation = await executeAdminAttestationAction(
      action.idempotencyKey,
      action.action === 'confirm'
        ? { action: 'confirm', targetIds: action.userIds }
        : action.action === 'update'
          ? {
              action: 'update',
              targetIds: action.userIds,
              field: action.field,
              value: action.value,
            }
          : action.action === 'confirm_and_issue'
            ? { action: 'confirm_and_issue', targetIds: action.attestationIds }
            : { action: 'issue', targetIds: action.attestationIds },
    );
    return NextResponse.json(operation);
  } catch (error) {
    return apiError(error);
  }
}
