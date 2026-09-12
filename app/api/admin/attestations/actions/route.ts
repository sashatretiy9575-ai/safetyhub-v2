import { NextResponse } from '@/lib/security/api-response';
import * as z from 'zod';
import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { readJsonBody } from '@/lib/security/request-body';
import { PROFILE_FIELD_LIMITS } from '@/lib/profile/fields';
import { requireAnyCapability, requireCapability } from '@/server/auth/session';
import {
  ADMIN_ATTESTATION_BULK_LIMIT,
  executeAdminAttestationAction,
} from '@/server/admin/attestations';

const ids = z
  .array(z.string().uuid())
  .min(1)
  .max(ADMIN_ATTESTATION_BULK_LIMIT)
  .refine((values) => new Set(values).size === values.length, 'DUPLICATE_TARGET_IDS');
const actionSchema = z.discriminatedUnion('action', [
  z
    .object({ action: z.literal('confirm'), userIds: ids, idempotencyKey: z.string().uuid() })
    .strict(),
  z
    .object({
      action: z.literal('update'),
      userIds: ids,
      field: z.enum(['name', 'surname', 'job', 'organization']),
      // Bounded per field: the columns hold 80 characters for a name and 160
      // for a job or a company. A single 200-character ceiling let a value
      // through to the column CHECK, where the whole batch rolled back with no
      // indication of which field was at fault.
      value: z.string().trim().min(1).max(PROFILE_FIELD_LIMITS.job),
      idempotencyKey: z.string().uuid(),
    })
    .strict()
    .superRefine((update, context) => {
      if (update.value.length > PROFILE_FIELD_LIMITS[update.field]) {
        context.addIssue({
          code: 'custom',
          path: ['value'],
          message: `FIELD_TOO_LONG:${update.field}:${PROFILE_FIELD_LIMITS[update.field]}`,
        });
      }
    }),
  z
    .object({ action: z.literal('issue'), attestationIds: ids, idempotencyKey: z.string().uuid() })
    .strict(),
  z
    .object({
      action: z.literal('confirm_and_issue'),
      attestationIds: ids,
      idempotencyKey: z.string().uuid(),
    })
    .strict(),
]);

export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    // Which capability this needs depends on the action, so the body has to be
    // read first — but only by somebody who holds at least one of them. Without
    // this an anonymous caller could make the server read and validate a body
    // for free; the precise check still happens below.
    await requireAnyCapability(['certificate.issue', 'identity.manage']);
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
