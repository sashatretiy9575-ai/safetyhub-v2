import 'server-only';

import { randomUUID } from 'node:crypto';
import { safeErrorDiagnosticCode } from '@/lib/security/error-diagnostics';
import * as z from 'zod';
import { requireCapability } from '@/server/auth/session';
import { createClient } from '@/server/supabase/server';
import { auditDateBoundary } from '@/lib/admin/audit-dates';
import { exclusiveRangeEnd, inclusiveRangeStart } from '@/server/admin/date-range';
import type {
  AdminAccountApprovalItem,
  AdminAuditEvent,
  AdminDataResult,
  AdminPage,
  LearningHistoryTarget,
} from '@/lib/admin/types';
import { resolveAvatarUrls } from '@/server/profile/avatar-manifests';

export const ADMIN_PAGE_SIZE = 25;

export type RawAdminSearchParams = Record<string, string | string[] | undefined>;

export type AdminAuditQuery = {
  localDates?: boolean;
  actor: string;
  target: string;
  action: string;
  from: string | null;
  to: string | null;
  cursorAt: string | null;
  cursorId: string | null;
};

export type AdminAccountApprovalQuery = {
  cursorAt: string | null;
  cursorId: string | null;
};

export type LearningHistoryTargetQuery = {
  query: string;
  cursorAt: string | null;
  cursorId: string | null;
};

type ReadRpcClient = {
  rpc(
    name:
      | 'list_admin_audit_page'
      | 'list_pending_account_approval_page'
      | 'list_learning_history_targets_page'
      | 'list_admin_operators_page'
      | 'list_pending_admin_grants',
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
};

const isoDateSchema = z.string().datetime({ offset: true });
const cursorSchema = z.object({ at: isoDateSchema, id: z.string().min(1) });
const pageEnvelope = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.coerce.number().int().nonnegative(),
    hasMore: z.boolean(),
    nextCursor: cursorSchema.nullable(),
  });

const ANONYMOUS_ACCOUNT_LABEL = 'Без имени';

const adminOperatorSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().nullable(),
    label: z.string().nullish(),
    createdAt: isoDateSchema,
    isSelf: z.boolean(),
    protected: z.boolean(),
  })
  .transform(({ label, ...operator }) => ({
    ...operator,
    label: label?.trim() || ANONYMOUS_ACCOUNT_LABEL,
  }));

export type AdminOperator = z.infer<typeof adminOperatorSchema>;

const learningHistoryTargetSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().nullable(),
    label: z.string().nullish(),
    role: z.literal('participant'),
    status: z.enum(['active', 'suspended']),
    createdAt: isoDateSchema,
  })
  .transform(({ label, ...target }) => ({
    ...target,
    label: label?.trim() || ANONYMOUS_ACCOUNT_LABEL,
  }));

const auditEventSchema = z.object({
  id: z.string().regex(/^\d+$/),
  actorUserId: z.string().uuid().nullable(),
  actorLabel: z.string(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  targetLabel: z.string(),
  details: z.record(z.string(), z.unknown()),
  correlationId: z.string().uuid(),
  requestId: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: isoDateSchema,
});

const adminAccountApprovalItemSchema = z.object({
  id: z.string().uuid(),
  // A redacted Chinese account has no email; a legacy row may carry an empty
  // string. Neither may reject the whole approval queue.
  email: z
    .union([z.string().email(), z.literal('')])
    .nullish()
    .transform((value) => value || null),
  username: z
    .string()
    .regex(/^[a-z][a-z0-9._-]{2,31}$/u)
    .nullable()
    .optional(),
  name: z.string().max(80),
  surname: z.string().max(80),
  job: z.string().max(160),
  organization: z.string().max(160),
  phoneCountryIso2: z
    .string()
    .regex(/^[A-Z]{2}$/u)
    .nullable(),
  phoneE164: z
    .string()
    .regex(/^\+[1-9][0-9]{1,14}$/u)
    .nullable(),
  avatarAvailable: z.boolean(),
  requestedAt: isoDateSchema,
  dueAt: isoDateSchema,
});

function first(params: RawAdminSearchParams, key: string) {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

function boundedText(params: RawAdminSearchParams, key: string) {
  return (first(params, key) ?? '').trim().slice(0, 100);
}

function cursorDate(params: RawAdminSearchParams, key = 'cursorAt') {
  const value = first(params, key);
  return value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function uuidCursor(params: RawAdminSearchParams, key = 'cursorId') {
  const value = first(params, key);
  return value && z.string().uuid().safeParse(value).success ? value : null;
}

function bigintCursor(params: RawAdminSearchParams) {
  const value = first(params, 'cursorId');
  return value && /^\d+$/.test(value) ? value : null;
}

function pairedCursor(at: string | null, id: string | null) {
  return at && id ? { at, id } : { at: null, id: null };
}

export function parseAdminAuditQuery(params: RawAdminSearchParams): AdminAuditQuery {
  const cursor = pairedCursor(cursorDate(params), bigintCursor(params));
  // Keep existing bookmarked UTC date ranges; new controls opt into local dates.
  const localDates =
    first(params, 'tz') === 'local' || (!first(params, 'from') && !first(params, 'to'));
  return {
    localDates,
    actor: boundedText(params, 'actor'),
    target: boundedText(params, 'target'),
    action: boundedText(params, 'action'),
    from: localDates
      ? auditDateBoundary(first(params, 'from'))
      : inclusiveRangeStart(first(params, 'from')),
    to: localDates
      ? auditDateBoundary(first(params, 'to'), true)
      : exclusiveRangeEnd(first(params, 'to')),
    cursorAt: cursor.at,
    cursorId: cursor.id,
  };
}

export function parseAdminAccountApprovalQuery(
  params: RawAdminSearchParams,
): AdminAccountApprovalQuery {
  const cursor = pairedCursor(cursorDate(params), uuidCursor(params));
  return { cursorAt: cursor.at, cursorId: cursor.id };
}

export type AdminOperatorQuery = {
  query: string;
  cursorAt: string | null;
  cursorId: string | null;
};

export function parseAdminOperatorQuery(params: RawAdminSearchParams): AdminOperatorQuery {
  const cursor = pairedCursor(cursorDate(params), uuidCursor(params));
  return {
    query: boundedText(params, 'q'),
    cursorAt: cursor.at,
    cursorId: cursor.id,
  };
}

export function parseLearningHistoryTargetQuery(
  params: RawAdminSearchParams,
): LearningHistoryTargetQuery {
  const cursor = pairedCursor(cursorDate(params), uuidCursor(params));
  return {
    query: boundedText(params, 'q'),
    cursorAt: cursor.at,
    cursorId: cursor.id,
  };
}

function loadFailure(error: unknown): AdminDataResult<never> {
  const correlationId = randomUUID();
  const cause = safeErrorDiagnosticCode(error, 'UNKNOWN_ADMIN_DATA_ERROR');
  console.error('ADMIN_DATA_LOAD_FAILED', { correlationId, cause });
  return { state: 'failed', correlationId };
}

async function readRpc(name: Parameters<ReadRpcClient['rpc']>[0], args?: Record<string, unknown>) {
  const client = (await createClient()) as unknown as ReadRpcClient;
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(error.code ? `${error.code}:${error.message}` : error.message);
  return data;
}

export async function getLearningHistoryTargetsPage(
  query: LearningHistoryTargetQuery,
): Promise<AdminDataResult<AdminPage<LearningHistoryTarget>>> {
  const actor = await requireCapability('results.delete');
  try {
    const data = await readRpc('list_learning_history_targets_page', {
      p_actor_id: actor.user.id,
      p_limit: ADMIN_PAGE_SIZE,
      p_query: query.query || null,
      p_cursor_created_at: query.cursorAt,
      p_cursor_id: query.cursorId,
    });
    return { state: 'ready', data: pageEnvelope(learningHistoryTargetSchema).parse(data) };
  } catch (error) {
    return loadFailure(error);
  }
}

export async function getAdminOperatorsPage(
  query: AdminOperatorQuery,
): Promise<AdminDataResult<AdminPage<AdminOperator>>> {
  await requireCapability('role.manage');
  try {
    const data = await readRpc('list_admin_operators_page', {
      p_limit: ADMIN_PAGE_SIZE,
      p_query: query.query || null,
      p_cursor_created_at: query.cursorAt,
      p_cursor_id: query.cursorId,
    });
    return { state: 'ready', data: pageEnvelope(adminOperatorSchema).parse(data) };
  } catch (error) {
    return loadFailure(error);
  }
}

const pendingAdminGrantSchema = z.object({
  email: z.string().min(3).max(254),
  reason: z.string(),
  createdAt: isoDateSchema,
});
export type PendingAdminGrant = z.infer<typeof pendingAdminGrantSchema>;

export async function getPendingAdminGrants(): Promise<
  AdminDataResult<{ items: PendingAdminGrant[] }>
> {
  await requireCapability('role.manage');
  try {
    const data = await readRpc('list_pending_admin_grants');
    return {
      state: 'ready',
      data: z.object({ items: z.array(pendingAdminGrantSchema) }).parse(data),
    };
  } catch (error) {
    return loadFailure(error);
  }
}

export async function getAdminAuditPage(
  query: AdminAuditQuery,
): Promise<AdminDataResult<AdminPage<AdminAuditEvent>>> {
  await requireCapability('audit.read');
  try {
    const data = await readRpc('list_admin_audit_page', {
      p_limit: ADMIN_PAGE_SIZE,
      p_actor: query.actor || null,
      p_target: query.target || null,
      p_action: query.action || null,
      p_from: query.from,
      p_to: query.to,
      p_cursor_created_at: query.cursorAt,
      p_cursor_id: query.cursorId,
    });
    return { state: 'ready', data: pageEnvelope(auditEventSchema).parse(data) };
  } catch (error) {
    return loadFailure(error);
  }
}

export async function getPendingAccountApprovalPage(
  query: AdminAccountApprovalQuery,
): Promise<AdminDataResult<AdminPage<AdminAccountApprovalItem>>> {
  await requireCapability('identity.manage');
  try {
    const data = await readRpc('list_pending_account_approval_page', {
      p_limit: ADMIN_PAGE_SIZE,
      p_cursor_due_at: query.cursorAt,
      p_cursor_user_id: query.cursorId,
    });
    const page = pageEnvelope(adminAccountApprovalItemSchema).parse(data);
    // One manifest read and one batch signing for the whole page, instead of
    // an admin-only avatar request per row that cost three round-trips each.
    const avatarUrls = await resolveAvatarUrls(
      page.items.filter((item) => item.avatarAvailable).map((item) => item.id),
    );
    return {
      state: 'ready',
      data: {
        ...page,
        items: page.items.map((item) => ({ ...item, avatarUrl: avatarUrls.get(item.id) ?? null })),
      },
    };
  } catch (error) {
    return loadFailure(error);
  }
}
