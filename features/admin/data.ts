import 'server-only';

import { randomUUID } from 'node:crypto';
import { safeErrorDiagnosticCode } from '@/lib/security/error-diagnostics';
import { z } from 'zod';
import { requireAnyCapability, requireCapability, requireRole } from '@/features/auth/server';
import { createClient } from '@/lib/supabase/server';
import type { AccountStatus, AppRole } from '@/lib/supabase/types';
import type {
  AdminAccessUser,
  AdminAuditEvent,
  AdminDataResult,
  AdminDataSummary,
  AdminPage,
  AdminUserListItem,
  AuthAdminOutboxItem,
  LearningHistoryTarget,
} from './types';

export const ADMIN_PAGE_SIZE = 25;

export type RawAdminSearchParams = Record<string, string | string[] | undefined>;

export type AdminUserQuery = {
  query: string;
  role: AppRole | null;
  status: AccountStatus | null;
  cursorAt: string | null;
  cursorId: string | null;
};

export type AdminAuditQuery = {
  actor: string;
  target: string;
  action: string;
  from: string | null;
  to: string | null;
  cursorAt: string | null;
  cursorId: string | null;
};

export type AdminAccessUserQuery = {
  query: string;
  cursorAt: string | null;
  cursorId: string | null;
};

export type AdminAccessOutboxQuery = {
  operationType: AuthAdminOutboxItem['operationType'] | null;
  state: AuthAdminOutboxItem['state'] | null;
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
      | 'get_admin_data_summary'
      | 'list_admin_users_page'
      | 'list_admin_audit_page'
      | 'list_admin_access_users_page'
      | 'list_admin_access_outbox_page'
      | 'list_learning_history_targets_page',
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

const adminCapabilitySchema = z.enum([
  'content.manage',
  'test.manage',
  'support.view',
  'user.read',
  'user.invite',
  'user.suspend',
  'user.delete',
  'role.manage',
  'identity.read',
  'identity.manage',
  'certificate.read',
  'certificate.issue',
  'certificate.revoke',
  'results.read',
  'results.delete',
  'results.export',
  'site.settings.manage',
  'audit.read',
  'capability.manage',
]);

const adminUserListItemSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    label: z.string().optional(),
    // Rolling-deploy compatibility: the previous RPC nested the display name in profile.
    // Zod strips every other legacy profile/identity/activity field before this result leaves
    // the server, and the follow-up migration removes those fields at the database boundary.
    profile: z.object({ name: z.string(), surname: z.string() }).optional(),
    role: z.enum(['user', 'admin', 'superadmin']),
    capabilities: z.array(adminCapabilitySchema),
    status: z.enum(['active', 'suspended']),
  })
  .transform(({ label, profile, role, ...user }) => ({
    ...user,
    role: role === 'user' ? ('participant' as const) : ('admin' as const),
    label:
      label?.trim() ||
      [profile?.name, profile?.surname].filter(Boolean).join(' ').trim() ||
      'Без имени',
  }));

const learningHistoryTargetSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  label: z.string(),
  role: z.literal('participant'),
  status: z.enum(['active', 'suspended']),
  createdAt: isoDateSchema,
});

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

const adminAccessUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  label: z.string(),
  capabilities: z.array(adminCapabilitySchema),
});

const authAdminOutboxSchema = z.object({
  id: z.string().uuid(),
  operationType: z.enum(['invite', 'suspend', 'restore']),
  state: z.enum([
    'prepared',
    'external_succeeded',
    'committed',
    'retryable',
    'rolled_back',
    'failed',
  ]),
  actorUserId: z.string().uuid(),
  actorLabel: z.string(),
  targetId: z.string().nullable(),
  targetLabel: z.string(),
  attempts: z.coerce.number().int().nonnegative(),
  lastError: z.string().nullable(),
  originalReason: z.string().nullable(),
  correlationId: z.string().uuid(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});

const summarySchema = z.object({
  users: z.coerce.number().int().nonnegative().nullable(),
  activeUsers: z.coerce.number().int().nonnegative().nullable(),
  suspendedUsers: z.coerce.number().int().nonnegative().nullable(),
  attempts: z.coerce.number().int().nonnegative().nullable(),
  passedAttempts: z.coerce.number().int().nonnegative().nullable(),
  activeCertificates: z.coerce.number().int().nonnegative().nullable(),
  revokedCertificates: z.coerce.number().int().nonnegative().nullable(),
  auditEvents24h: z.coerce.number().int().nonnegative().nullable(),
  tests: z.coerce.number().int().nonnegative().nullable(),
  generatedAt: isoDateSchema,
});

function first(params: RawAdminSearchParams, key: string) {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

function boundedText(params: RawAdminSearchParams, key: string) {
  return (first(params, key) ?? '').trim().slice(0, 100);
}

function enumValue<T extends string>(value: string | undefined, values: readonly T[]): T | null {
  return value && values.includes(value as T) ? (value as T) : null;
}

function dateBoundary(value: string | undefined, endExclusive: boolean) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime())) return null;
  if (endExclusive) instant.setUTCDate(instant.getUTCDate() + 1);
  return instant.toISOString();
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

export function parseAdminUserQuery(params: RawAdminSearchParams): AdminUserQuery {
  const cursor = pairedCursor(cursorDate(params), uuidCursor(params));
  return {
    query: boundedText(params, 'q'),
    role: enumValue(first(params, 'role'), ['participant', 'admin'] as const),
    status: enumValue(first(params, 'status'), ['active', 'suspended'] as const),
    cursorAt: cursor.at,
    cursorId: cursor.id,
  };
}

export function parseAdminAuditQuery(params: RawAdminSearchParams): AdminAuditQuery {
  const cursor = pairedCursor(cursorDate(params), bigintCursor(params));
  return {
    actor: boundedText(params, 'actor'),
    target: boundedText(params, 'target'),
    action: boundedText(params, 'action'),
    from: dateBoundary(first(params, 'from'), false),
    to: dateBoundary(first(params, 'to'), true),
    cursorAt: cursor.at,
    cursorId: cursor.id,
  };
}

export function parseAdminAccessUserQuery(params: RawAdminSearchParams): AdminAccessUserQuery {
  const cursor = pairedCursor(
    cursorDate(params, 'userCursorAt'),
    uuidCursor(params, 'userCursorId'),
  );
  return {
    query: boundedText(params, 'userQ'),
    cursorAt: cursor.at,
    cursorId: cursor.id,
  };
}

export function parseAdminAccessOutboxQuery(params: RawAdminSearchParams): AdminAccessOutboxQuery {
  const cursor = pairedCursor(
    cursorDate(params, 'outboxCursorAt'),
    uuidCursor(params, 'outboxCursorId'),
  );
  return {
    operationType: enumValue(first(params, 'outboxType'), [
      'invite',
      'suspend',
      'restore',
    ] as const),
    state: enumValue(first(params, 'outboxState'), [
      'prepared',
      'external_succeeded',
      'committed',
      'retryable',
      'rolled_back',
      'failed',
    ] as const),
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

export async function getAdminDataSummary(): Promise<AdminDataResult<AdminDataSummary>> {
  await requireAnyCapability([
    'user.read',
    'results.read',
    'certificate.read',
    'audit.read',
    'test.manage',
  ]);
  try {
    return { state: 'ready', data: summarySchema.parse(await readRpc('get_admin_data_summary')) };
  } catch (error) {
    return loadFailure(error);
  }
}

export async function getAdminUsersPage(
  query: AdminUserQuery,
): Promise<AdminDataResult<AdminPage<AdminUserListItem>>> {
  await requireAnyCapability(['user.read']);
  try {
    const data = await readRpc('list_admin_users_page', {
      p_limit: ADMIN_PAGE_SIZE,
      p_query: query.query || null,
      p_role: query.role === 'participant' ? 'user' : query.role,
      p_status: query.status,
      p_cursor_created_at: query.cursorAt,
      p_cursor_id: query.cursorId,
    });
    return { state: 'ready', data: pageEnvelope(adminUserListItemSchema).parse(data) };
  } catch (error) {
    return loadFailure(error);
  }
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

export async function getAdminAccessUsersPage(
  query: AdminAccessUserQuery,
): Promise<AdminDataResult<AdminPage<AdminAccessUser>>> {
  await requireRole(['admin']);
  await requireCapability('capability.manage');
  try {
    const data = await readRpc('list_admin_access_users_page', {
      p_limit: ADMIN_PAGE_SIZE,
      p_query: query.query || null,
      p_cursor_created_at: query.cursorAt,
      p_cursor_id: query.cursorId,
    });
    return { state: 'ready', data: pageEnvelope(adminAccessUserSchema).parse(data) };
  } catch (error) {
    return loadFailure(error);
  }
}

export async function getAdminAccessOutboxPage(
  query: AdminAccessOutboxQuery,
): Promise<AdminDataResult<AdminPage<AuthAdminOutboxItem>>> {
  await requireRole(['admin']);
  await requireCapability('capability.manage');
  try {
    const data = await readRpc('list_admin_access_outbox_page', {
      p_limit: ADMIN_PAGE_SIZE,
      p_operation_type: query.operationType,
      p_state: query.state,
      p_cursor_updated_at: query.cursorAt,
      p_cursor_id: query.cursorId,
    });
    return { state: 'ready', data: pageEnvelope(authAdminOutboxSchema).parse(data) };
  } catch (error) {
    return loadFailure(error);
  }
}
