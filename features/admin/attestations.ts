import 'server-only';

import { randomUUID } from 'node:crypto';
import { safeErrorDiagnosticCode } from '@/lib/security/error-diagnostics';
import { z } from 'zod';
import { requireAnyCapability, requireCapability } from '@/features/auth/server';
import { invalidateCertificateVerificationCache } from '@/features/certificates/server';
import { createClient } from '@/lib/supabase/server';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';
import type {
  AdminAttestationMutationItem,
  AdminAttestationFilters,
  AdminAttestationPage,
  AdminAttestationSelection,
  AdminDataResult,
  AdminWorkQueue,
} from './types';

export const ADMIN_ATTESTATION_DEFAULT_PAGE_SIZE = 50;
export const ADMIN_ATTESTATION_PAGE_SIZES = [25, 50, 100] as const;
export const ADMIN_ATTESTATION_BULK_LIMIT = 500;

export const ADMIN_ATTESTATION_SORTS = [
  'name_asc',
  'organization_asc',
  'completed_desc',
  'completed_asc',
  'score_desc',
  'score_asc',
] as const;

export const ADMIN_ATTESTATION_RESULT_STATES = ['passed', 'failed'] as const;
export const ADMIN_ATTESTATION_CERTIFICATE_STATES = [
  'pending_identity',
  'ready',
  'issued',
  'revoked',
] as const;

export type AdminAttestationSort = (typeof ADMIN_ATTESTATION_SORTS)[number];
export type AdminAttestationResultFilter = (typeof ADMIN_ATTESTATION_RESULT_STATES)[number];
export type AdminAttestationCertificateFilter =
  (typeof ADMIN_ATTESTATION_CERTIFICATE_STATES)[number];

export type AdminAttestationQuery = {
  query: string;
  organization: string;
  testId: string | null;
  resultState: AdminAttestationResultFilter | null;
  certificateState: AdminAttestationCertificateFilter | null;
  from: string | null;
  to: string | null;
  sort: AdminAttestationSort;
  pageSize: (typeof ADMIN_ATTESTATION_PAGE_SIZES)[number];
  cursor: { values: unknown[]; id: string } | null;
};

export type RawAdminAttestationSearchParams = Record<string, string | string[] | undefined>;

type RpcError = { code?: string; message: string };
type UntypedRpcClient = {
  rpc(
    name:
      | 'list_admin_attestations_page'
      | 'get_admin_attestation_filters'
      | 'get_admin_work_queue'
      | 'get_admin_attestation_by_certificate_number'
      | 'resolve_admin_attestation_selection'
      | 'confirm_admin_identities'
      | 'bulk_update_participants'
      | 'issue_certificates'
      | 'revoke_certificates'
      | 'execute_admin_attestation_action',
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
};

const isoDateSchema = z.string().datetime({ offset: true });
const uuidArraySchema = z.array(z.string().uuid()).max(ADMIN_ATTESTATION_BULK_LIMIT);
const cursorSchema = z.object({ values: z.array(z.unknown()).max(12), id: z.string().min(1) });
const mutationReasonSchema = z
  .string()
  .max(96)
  .regex(/^[A-Z][A-Z0-9_]{1,95}(?::[0-9]{1,10})?$/u)
  .nullable();

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function first(source: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) if (source[key] !== undefined) return source[key];
  return undefined;
}

const rowSchema = z.preprocess(
  (value) => {
    const row = record(value);
    const rawFullName = String(first(row, 'fullName', 'full_name') ?? '')
      .normalize('NFC')
      .trim();
    // A Chinese username/password learner is admitted without a profile, so the
    // row legitimately carries no display name. Rejecting it here failed the
    // entire employees page instead of one cell.
    const fullName =
      rawFullName ||
      [first(row, 'name', 'profile_name'), first(row, 'surname', 'profile_surname')]
        .map((part) => (typeof part === 'string' ? part.trim() : ''))
        .filter(Boolean)
        .join(' ') ||
      'Без имени';
    const pieces = rawFullName.split(/\s+/u).filter(Boolean);
    const rawRecordId = first(row, 'recordId', 'record_id', 'attestationId', 'attestation_id');
    const rawTestId = first(row, 'testId', 'test_id') ?? null;
    const rawRevisionId = first(row, 'revisionId', 'revision_id') ?? null;
    const courseDeleted =
      first(row, 'courseDeleted', 'course_deleted') === true ||
      (rawTestId === null && rawRevisionId === null);
    return {
      recordId: rawRecordId,
      kind: courseDeleted ? 'deleted-course-certificate' : 'attestation',
      attestationId: courseDeleted ? null : rawRecordId,
      userId: first(row, 'userId', 'user_id'),
      bestAttemptId: first(row, 'bestAttemptId', 'best_attempt_id') ?? null,
      revisionId: rawRevisionId,
      testId: rawTestId,
      testVersion: courseDeleted ? null : first(row, 'testVersion', 'test_version'),
      name: first(row, 'name', 'profile_name') ?? pieces[0] ?? '',
      surname: first(row, 'surname', 'profile_surname') ?? pieces.slice(1).join(' '),
      fullName,
      job: first(row, 'job'),
      organization: first(row, 'organization'),
      organizationGroupCount: first(row, 'organizationGroupCount', 'organization_group_count') ?? 1,
      avatarAvailable: first(row, 'avatarAvailable', 'avatar_available') ?? false,
      avatarUrl: first(row, 'avatarUrl', 'avatar_url') ?? null,
      courseTitle: first(row, 'courseTitle', 'course_title', 'test_title'),
      score: first(row, 'score'),
      total: first(row, 'total'),
      passScore: first(row, 'passScore', 'pass_score'),
      completedAt: first(row, 'completedAt', 'completed_at'),
      identityState: first(row, 'identityState', 'identity_state'),
      certificateState: first(row, 'certificateState', 'certificate_state'),
      certificateId: first(row, 'certificateId', 'certificate_id') ?? null,
      certificateScore: first(row, 'certificateScore', 'certificate_score') ?? null,
      certificateNumber: first(row, 'certificateNumber', 'certificate_number') ?? null,
      scoreImproved: first(row, 'scoreImproved', 'score_improved') ?? false,
      courseDeleted,
    };
  },
  z.object({
    recordId: z.string().uuid(),
    kind: z.enum(['attestation', 'deleted-course-certificate']),
    attestationId: z.string().uuid().nullable(),
    userId: z.string().uuid(),
    bestAttemptId: z.string().uuid().nullable(),
    revisionId: z.string().uuid().nullable(),
    testId: z.string().uuid().nullable(),
    testVersion: z.coerce.number().int().positive().nullable(),
    name: z.string(),
    surname: z.string(),
    fullName: z.string().min(1),
    job: z.string(),
    organization: z.string(),
    organizationGroupCount: z.coerce.number().int().positive(),
    avatarAvailable: z.boolean(),
    avatarUrl: z.string().url().nullable(),
    courseTitle: z.string().min(1),
    score: z.coerce.number().int().nonnegative(),
    total: z.coerce.number().int().positive(),
    passScore: z.coerce.number().int().nonnegative(),
    completedAt: isoDateSchema,
    identityState: z.enum(['pending', 'verified', 'changed', 'revoked']),
    certificateState: z.enum(['not_eligible', 'pending_identity', 'ready', 'issued', 'revoked']),
    certificateId: z.string().uuid().nullable(),
    certificateScore: z.coerce.number().int().nonnegative().nullable(),
    certificateNumber: z.string().nullable(),
    scoreImproved: z.boolean(),
    courseDeleted: z.boolean(),
  }),
);

const pageSchema = z.preprocess(
  (value) => {
    const page = record(value);
    return {
      items: first(page, 'items') ?? [],
      total: first(page, 'total') ?? 0,
      hasMore: first(page, 'hasMore', 'has_more') ?? false,
      nextCursor: first(page, 'nextCursor', 'next_cursor') ?? null,
    };
  },
  z.object({
    items: z.array(rowSchema),
    total: z.coerce.number().int().nonnegative(),
    hasMore: z.boolean(),
    nextCursor: cursorSchema.nullable(),
  }),
);

const filtersSchema = z.preprocess(
  (value) => {
    const filters = record(value);
    return {
      organizations: first(filters, 'organizations') ?? [],
      courses: first(filters, 'courses') ?? [],
    };
  },
  z.object({
    organizations: z.array(z.string()),
    courses: z.array(
      z.preprocess(
        (value) => {
          const course = record(value);
          return {
            id: first(course, 'id', 'test_id'),
            title: first(course, 'title', 'course_title'),
          };
        },
        z.object({ id: z.string().uuid(), title: z.string().min(1) }),
      ),
    ),
  }),
);

const workQueueSchema = z.object({
  pendingIdentity: z.coerce.number().int().nonnegative(),
  readyToIssue: z.coerce.number().int().nonnegative(),
  companyIssues: z.coerce.number().int().nonnegative(),
  activeCertificates: z.coerce.number().int().nonnegative(),
  generatedAt: isoDateSchema,
});

const selectionSchema = z.preprocess(
  (value) => {
    const selection = record(value);
    return {
      recordIds:
        first(selection, 'recordIds', 'record_ids') ??
        first(selection, 'attestationIds', 'attestation_ids') ??
        [],
      attestationIds: first(selection, 'attestationIds', 'attestation_ids') ?? [],
      userIds: first(selection, 'userIds', 'user_ids') ?? [],
      certificateIds: first(selection, 'certificateIds', 'certificate_ids') ?? [],
      total: first(selection, 'total') ?? 0,
      uniquePeople: first(selection, 'uniquePeople', 'unique_people') ?? 0,
      pendingIdentity: first(selection, 'pendingIdentity', 'pending_identity') ?? 0,
      ready: first(selection, 'ready') ?? 0,
      issued: first(selection, 'issued') ?? 0,
      exportable: first(selection, 'exportable') ?? 0,
    };
  },
  z.object({
    recordIds: uuidArraySchema,
    attestationIds: uuidArraySchema,
    userIds: uuidArraySchema,
    certificateIds: uuidArraySchema,
    total: z.coerce.number().int().nonnegative().max(ADMIN_ATTESTATION_BULK_LIMIT),
    uniquePeople: z.coerce.number().int().nonnegative().max(ADMIN_ATTESTATION_BULK_LIMIT),
    pendingIdentity: z.coerce.number().int().nonnegative().max(ADMIN_ATTESTATION_BULK_LIMIT),
    ready: z.coerce.number().int().nonnegative().max(ADMIN_ATTESTATION_BULK_LIMIT),
    issued: z.coerce.number().int().nonnegative().max(ADMIN_ATTESTATION_BULK_LIMIT),
    exportable: z.coerce.number().int().nonnegative().max(ADMIN_ATTESTATION_BULK_LIMIT),
  }),
);

const mutationItemsSchema = z.preprocess(
  (value) => {
    const envelope = record(value);
    const items = Array.isArray(value) ? value : (first(envelope, 'items', 'results') ?? []);
    return Array.isArray(items)
      ? items.map((item) => {
          const row = record(item);
          const rawStatus = String(first(row, 'status', 'state') ?? 'completed');
          const status = ['already_completed', 'already_done', 'unchanged'].includes(rawStatus)
            ? 'already_completed'
            : ['skipped', 'rejected', 'failed'].includes(rawStatus)
              ? 'skipped'
              : 'completed';
          return {
            id: first(row, 'id', 'target_id', 'user_id', 'attempt_id', 'certificate_id'),
            status,
            reason: first(row, 'reason', 'message') ?? null,
          };
        })
      : items;
  },
  z
    .array(
      z.object({
        id: z.string().min(1),
        status: z.enum(['completed', 'already_completed', 'skipped']),
        reason: mutationReasonSchema,
      }),
    )
    .max(ADMIN_ATTESTATION_BULK_LIMIT),
);

function param(params: RawAdminAttestationSearchParams, key: string) {
  const value = params[key];
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

function dateBoundary(value: string, end: boolean) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf())) return null;
  if (end) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

export function encodeAdminAttestationCursor(cursor: AdminAttestationQuery['cursor']) {
  return cursor ? Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url') : '';
}

function parseCursor(value: string) {
  if (!value || value.length > 4096) return null;
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}

export function parseAdminAttestationQuery(
  params: RawAdminAttestationSearchParams,
): AdminAttestationQuery {
  const sort = z.enum(ADMIN_ATTESTATION_SORTS).safeParse(param(params, 'sort'));
  const resultState = z.enum(ADMIN_ATTESTATION_RESULT_STATES).safeParse(param(params, 'result'));
  const certificateState = z
    .enum(ADMIN_ATTESTATION_CERTIFICATE_STATES)
    .safeParse(param(params, 'certificate'));
  const testId = z.string().uuid().safeParse(param(params, 'course'));
  const pageSize = z.coerce
    .number()
    .pipe(z.union([z.literal(25), z.literal(50), z.literal(100)]))
    .safeParse(param(params, 'pageSize'));
  return {
    query: param(params, 'q').trim().normalize('NFC').slice(0, 160),
    organization: param(params, 'organization').trim().normalize('NFC').slice(0, 200),
    testId: testId.success ? testId.data : null,
    resultState: resultState.success ? resultState.data : null,
    certificateState: certificateState.success ? certificateState.data : null,
    from: dateBoundary(param(params, 'from'), false),
    to: dateBoundary(param(params, 'to'), true),
    sort: sort.success ? sort.data : 'completed_desc',
    pageSize: pageSize.success ? pageSize.data : ADMIN_ATTESTATION_DEFAULT_PAGE_SIZE,
    cursor: parseCursor(param(params, 'cursor')),
  };
}

export const adminAttestationFilterInputSchema = z.object({
  query: z.string().trim().max(160).default(''),
  organization: z.string().trim().max(200).default(''),
  testId: z.string().uuid().nullable().default(null),
  resultState: z.enum(ADMIN_ATTESTATION_RESULT_STATES).nullable().default(null),
  certificateState: z.enum(ADMIN_ATTESTATION_CERTIFICATE_STATES).nullable().default(null),
  from: isoDateSchema.nullable().default(null),
  to: isoDateSchema.nullable().default(null),
  sort: z.enum(ADMIN_ATTESTATION_SORTS).default('completed_desc'),
});

function filterArgs(
  query: AdminAttestationQuery | z.infer<typeof adminAttestationFilterInputSchema>,
) {
  return {
    p_query: query.query || null,
    p_organization: query.organization || null,
    p_test_id: query.testId,
    p_result_state: query.resultState,
    p_certificate_state: query.certificateState,
    p_from: query.from,
    p_to: query.to,
    p_sort: query.sort,
  };
}

async function rpc(name: Parameters<UntypedRpcClient['rpc']>[0], args: Record<string, unknown>) {
  const result = await ((await createClient()) as unknown as UntypedRpcClient).rpc(name, args);
  return unwrapRpcMutationResponse(result);
}

function loadFailure(error: unknown): AdminDataResult<never> {
  const correlationId = randomUUID();
  console.error('ADMIN_ATTESTATIONS_LOAD_FAILED', {
    correlationId,
    cause: safeErrorDiagnosticCode(error, 'UNKNOWN_ADMIN_ATTESTATIONS_ERROR'),
  });
  return { state: 'failed', correlationId };
}

export async function getAdminAttestationsPage(
  query: AdminAttestationQuery,
): Promise<AdminDataResult<AdminAttestationPage>> {
  await requireCapability('results.read');
  try {
    if (query.query) {
      const exactCertificate = pageSchema.parse(
        await rpc('get_admin_attestation_by_certificate_number', { p_query: query.query }),
      ) as AdminAttestationPage;
      if (exactCertificate.total > 0) return { state: 'ready', data: exactCertificate };
    }
    const data = await rpc('list_admin_attestations_page', {
      p_limit: query.pageSize,
      ...filterArgs(query),
      p_cursor: query.cursor,
    });
    return { state: 'ready', data: pageSchema.parse(data) as AdminAttestationPage };
  } catch (error) {
    return loadFailure(error);
  }
}

export async function getAdminAttestationFilters(): Promise<AdminAttestationFilters> {
  await requireCapability('results.read');
  return filtersSchema.parse(await rpc('get_admin_attestation_filters', {}));
}

export async function getAdminWorkQueue(): Promise<AdminDataResult<AdminWorkQueue>> {
  await requireCapability('results.read');
  try {
    return {
      state: 'ready',
      data: workQueueSchema.parse(await rpc('get_admin_work_queue', {})),
    };
  } catch (error) {
    return loadFailure(error);
  }
}

export async function resolveAdminAttestationSelection(
  filters: z.infer<typeof adminAttestationFilterInputSchema>,
): Promise<AdminAttestationSelection> {
  await requireCapability('results.read');
  return selectionSchema.parse(
    await rpc('resolve_admin_attestation_selection', filterArgs(filters)),
  );
}

export async function confirmAdminIdentities(userIds: string[]) {
  await requireCapability('identity.manage');
  const result = mutationItemsSchema.parse(
    await rpc('confirm_admin_identities', { p_user_ids: uuidArraySchema.parse(userIds) }),
  ) satisfies AdminAttestationMutationItem[];
  invalidateCertificateVerificationCache();
  return result;
}

export async function updateAdminParticipants(
  userIds: string[],
  field: 'name' | 'surname' | 'job' | 'organization',
  value: string,
) {
  await requireCapability('identity.manage');
  const ids = uuidArraySchema.min(1).parse(userIds);
  if ((field === 'name' || field === 'surname') && ids.length !== 1) {
    throw new Error('INDIVIDUAL_NAME_UPDATE_REQUIRED');
  }
  const normalized = z.string().trim().min(1).max(200).parse(value).normalize('NFC');
  const result = mutationItemsSchema.parse(
    await rpc('bulk_update_participants', {
      p_user_ids: ids,
      p_field: field,
      p_value: normalized,
    }),
  ) satisfies AdminAttestationMutationItem[];
  invalidateCertificateVerificationCache();
  return result;
}

export async function issueAdminCertificates(attestationIds: string[]) {
  await requireCapability('certificate.issue');
  const result = mutationItemsSchema.parse(
    await rpc('issue_certificates', {
      p_attestation_ids: uuidArraySchema.min(1).parse(attestationIds),
    }),
  ) satisfies AdminAttestationMutationItem[];
  invalidateCertificateVerificationCache();
  return result;
}

export async function revokeAdminCertificates(certificateIds: string[], reason: string) {
  await requireCapability('certificate.revoke');
  const result = mutationItemsSchema.parse(
    await rpc('revoke_certificates', {
      p_certificate_ids: uuidArraySchema.min(1).parse(certificateIds),
      p_reason: z.string().trim().min(3).max(500).parse(reason).normalize('NFC'),
    }),
  ) satisfies AdminAttestationMutationItem[];
  invalidateCertificateVerificationCache();
  return result;
}

export type AdminAttestationAction =
  | { action: 'confirm'; targetIds: string[] }
  | {
      action: 'update';
      targetIds: string[];
      field: 'name' | 'surname' | 'job' | 'organization';
      value: string;
    }
  | { action: 'issue'; targetIds: string[] }
  | { action: 'revoke'; targetIds: string[]; reason: string };

export async function executeAdminAttestationAction(
  idempotencyKey: string,
  action: AdminAttestationAction,
) {
  const raw = await rpc('execute_admin_attestation_action', {
    p_idempotency_key: z.string().uuid().parse(idempotencyKey),
    p_action: action.action,
    p_target_ids: uuidArraySchema.min(1).parse(action.targetIds),
    p_field: action.action === 'update' ? action.field : null,
    p_value: action.action === 'update' ? action.value : null,
    p_reason: action.action === 'revoke' ? action.reason : null,
  });
  const envelope = record(raw);
  return {
    operationId: z.string().uuid().parse(envelope.operationId),
    replayed: z.boolean().parse(envelope.replayed),
    items: mutationItemsSchema.parse(raw),
  };
}

export async function requireAttestationReadAccess() {
  return requireAnyCapability(['results.read', 'identity.read', 'certificate.read']);
}
