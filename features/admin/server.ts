import 'server-only';

import { revalidatePath, revalidateTag } from 'next/cache';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';
import { requireCapability, requireRole } from '@/features/auth/server';
import {
  createPendingInviteContext,
  newPasswordContextToken,
} from '@/features/auth/password-change';
import type { AppRole, Json, TestRow } from '@/lib/supabase/types';
import type { InviteUserValues, SaveTestValues } from '@/lib/validation/admin';
import type { AdminCapability } from '@/lib/security/capabilities';
import type {
  ActivatedCourseCatalogBatch,
  AdminLearningHistory,
  AdminLearningHistoryDeletion,
  CourseCatalogMaintenance,
  CourseCatalogMaintenanceState,
  CoursePresentationRetirement,
  PreparedCourseCatalogBatch,
} from '@/features/admin/types';
import type { AdminRequestMetadata } from '@/lib/security/request-metadata';
import { consumeCoarseQuota } from '@/lib/security/rate-limit';
import { CONTENT_CACHE_TAG, TOPICS_CACHE_TAG } from '@/lib/content/cache-policy';
import { getSiteUrl } from '@/features/auth/server';
import { invalidateCertificateVerificationCache } from '@/features/certificates/server';

type RpcError = { message: string; code?: string };
type UntypedRpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
};

type OutboxHandle = { operationId: string; completionToken: string };
type ClaimedOutbox = OutboxHandle & {
  operationType: 'invite' | 'suspend' | 'restore';
  state: 'prepared' | 'external_succeeded' | 'retryable';
  externalTargetId: string | null;
  payload: Record<string, unknown>;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OUTBOX_COMPLETION_TOKEN_PATTERN = /^[0-9a-f]{64}$/u;

function untypedClient(client: unknown) {
  return client as UntypedRpcClient;
}

function outboxHandle(value: unknown): OutboxHandle {
  const result = value as Partial<OutboxHandle> | null;
  if (
    !result ||
    typeof result.operationId !== 'string' ||
    !UUID_PATTERN.test(result.operationId) ||
    typeof result.completionToken !== 'string' ||
    !OUTBOX_COMPLETION_TOKEN_PATTERN.test(result.completionToken)
  ) {
    throw new Error('OUTBOX_HANDLE_INVALID');
  }
  return { operationId: result.operationId, completionToken: result.completionToken };
}

function externalErrorMessage(error: unknown) {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String(error.message)
      : 'AUTH_ADMIN_OPERATION_FAILED';
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/\b[A-Za-z0-9_-]{43,}\b/g, '[redacted-token]')
    .slice(0, 500);
}

type OutboxErrorCategory =
  | 'AUTH_ADMIN_CONFLICT'
  | 'AUTH_ADMIN_NOT_FOUND'
  | 'AUTH_ADMIN_REJECTED'
  | 'AUTH_ADMIN_UNAVAILABLE'
  | 'AUTH_ADMIN_UNKNOWN';

function outboxErrorCategory(error: unknown): OutboxErrorCategory {
  const message = externalErrorMessage(error).toLowerCase();
  const status =
    error && typeof error === 'object' && 'status' in error ? Number(error.status) : Number.NaN;
  if (status === 404 || message.includes('not found')) return 'AUTH_ADMIN_NOT_FOUND';
  if (
    status === 409 ||
    message.includes('already') ||
    message.includes('conflict') ||
    message.includes('duplicate')
  ) {
    return 'AUTH_ADMIN_CONFLICT';
  }
  if (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 422 ||
    message.includes('invalid') ||
    message.includes('forbidden') ||
    message.includes('unauthorized')
  ) {
    return 'AUTH_ADMIN_REJECTED';
  }
  if (status === 429 || status >= 500) return 'AUTH_ADMIN_UNAVAILABLE';
  return 'AUTH_ADMIN_UNKNOWN';
}

async function advanceOutbox(
  handle: OutboxHandle,
  state: 'external_succeeded' | 'committed' | 'retryable' | 'rolled_back' | 'failed',
  externalTargetId: string | null = null,
  error: unknown = null,
) {
  const { error: rpcError } = await untypedClient(createAdminClient()).rpc(
    'advance_auth_admin_operation',
    {
      p_operation_id: handle.operationId,
      p_completion_token: handle.completionToken,
      p_state: state,
      p_external_target_id: externalTargetId,
      p_error: error ? outboxErrorCategory(error) : null,
    },
  );
  if (rpcError) throw new Error(rpcError.message);
}

async function authenticatedRpc(name: string, args: Record<string, unknown>) {
  return unwrapRpcMutationResponse(await untypedClient(await createClient()).rpc(name, args));
}

function metadataArgs(metadata: AdminRequestMetadata) {
  return {
    p_correlation_id: metadata.correlationId,
    p_request_id: metadata.requestId,
    p_ip_hash: metadata.ipHash,
    p_user_agent: metadata.userAgent,
  };
}

function invalidateTestContent(slug?: string | null) {
  revalidateTag(CONTENT_CACHE_TAG, { expire: 0 });
  revalidateTag(TOPICS_CACHE_TAG, { expire: 0 });
  for (const path of ['/', '/topics', '/sitemap.xml', '/admin']) revalidatePath(path);
  if (slug) revalidatePath(`/topics/${slug}`);
}

export async function inviteUser(values: InviteUserValues, metadata: AdminRequestMetadata) {
  await requireCapability('user.invite');
  await consumeCoarseQuota('admin.invite', metadata.ipHash);
  const admin = createAdminClient();
  const origin = getSiteUrl().replace(/\/$/, '');
  const passwordTicket = newPasswordContextToken();
  const handle = outboxHandle(
    await authenticatedRpc('prepare_user_invite', {
      p_email: values.email,
      p_name: values.name,
      p_surname: values.surname,
      p_job: values.job,
      p_requested_role: values.role === 'participant' ? 'user' : 'admin',
      p_password_ticket: passwordTicket,
      p_redirect_origin: origin,
      ...metadataArgs(metadata),
    }),
  );
  const { data, error } = await admin.auth.admin.inviteUserByEmail(values.email, {
    data: {
      name: values.name,
      surname: values.surname,
      job: values.job,
      safetyhubInviteCorrelation: metadata.correlationId,
    },
    // Admin invites use the implicit flow: unlike signup/recovery, they do not
    // support PKCE. The browser bridge sends its tokens to a server endpoint;
    // the opaque ticket is independently checked and consumed server-side.
    redirectTo: `${origin}/auth/invite?ticket=${encodeURIComponent(passwordTicket)}`,
  });
  if (error) {
    await advanceOutbox(handle, 'retryable', null, error);
    throw error;
  }
  try {
    await advanceOutbox(handle, 'external_succeeded', data.user.id);
    await createPendingInviteContext(data.user.id, passwordTicket);
    await advanceOutbox(handle, 'committed', data.user.id);
  } catch (contextError) {
    // The exact Auth target is durable and can be reconciled idempotently.
    // Direct Auth deletion would bypass the all-account Storage tombstone gate.
    await advanceOutbox(handle, 'retryable', data.user.id, contextError);
    throw contextError;
  }
  return data.user.id;
}

export async function setUserSuspended(
  userId: string,
  suspended: boolean,
  reason: string,
  metadata: AdminRequestMetadata,
) {
  await requireCapability('user.suspend');
  await consumeCoarseQuota('admin.suspend', metadata.ipHash);
  const admin = createAdminClient();
  // Clear before prepare as well: the SQL transaction can commit even if its
  // response is lost. Clearing an unrelated/global tag on a rejected prepare
  // is harmless, while leaving a pre-suspension projection is not.
  invalidateCertificateVerificationCache();
  try {
    const handle = outboxHandle(
      await authenticatedRpc('request_account_suspension_confirmed', {
        p_target_id: userId,
        p_suspended: suspended,
        p_reason: reason,
        ...metadataArgs(metadata),
      }),
    );
    // Suspension is fail-closed in Postgres after prepare. Evict again before
    // the external Auth call so no read racing the prepare can keep the old
    // certificate projection during that call.
    invalidateCertificateVerificationCache();
    const authResult = await admin.auth.admin.updateUserById(userId, {
      ban_duration: suspended ? '876000h' : 'none',
    });
    if (authResult.error) {
      await advanceOutbox(handle, 'retryable', userId, authResult.error);
      throw authResult.error;
    }
    await advanceOutbox(handle, 'external_succeeded', userId);
    await advanceOutbox(handle, 'committed', userId);
  } finally {
    invalidateCertificateVerificationCache();
  }
}

export async function changeUserRole(
  userId: string,
  role: AppRole,
  reason: string,
  metadata: AdminRequestMetadata,
) {
  await requireRole(['admin']);
  await requireCapability('role.manage');
  await authenticatedRpc('manage_user_role_confirmed', {
    p_target_id: userId,
    p_role: role,
    p_reason: reason,
    ...metadataArgs(metadata),
  });
}

export async function permanentlyDeleteUser(
  userId: string,
  reason: string,
  metadata: AdminRequestMetadata,
) {
  await requireRole(['admin']);
  const actor = await requireCapability('user.delete');
  if (userId === actor.user.id) throw new Error('CANNOT_DELETE_SELF');
  await consumeCoarseQuota('admin.delete', metadata.ipHash);
  const admin = createAdminClient();
  // Validate and retain the explicit operator reason only for the duration of
  // this request: the approved deletion semantics remove every related audit row.
  if (reason.trim().length < 10) throw new Error('DELETE_REASON_REQUIRED');
  const begin = await untypedClient(admin).rpc('begin_user_account_purge', {
    p_target_id: userId,
  });
  if (begin.error) throw new Error(begin.error.message);
  const pending = begin.data as Record<string, unknown> | null;
  if (
    !pending ||
    pending.userId !== userId ||
    pending.exists !== true ||
    pending.pending !== true ||
    typeof pending.tombstoneId !== 'string' ||
    typeof pending.cleanupNotBefore !== 'string'
  ) {
    throw new Error('ACCOUNT_PURGE_CONTRACT_INVALID');
  }
  invalidateCertificateVerificationCache();
  return {
    pending: true,
    state: pending.state,
    cleanupNotBefore: pending.cleanupNotBefore,
  };
}

export type AdminTestRow = TestRow & {
  has_draft_changes: boolean;
  draft_version: number | null;
};

export async function listTests(): Promise<AdminTestRow[]> {
  await requireCapability('test.manage');
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('tests')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  const testIds = (data ?? []).map((test) => test.id);
  const drafts = testIds.length
    ? await admin.from('course_drafts').select('*').in('test_id', testIds)
    : { data: [], error: null };
  if (drafts.error) throw drafts.error;
  const draftByTest = new Map((drafts.data ?? []).map((draft) => [draft.test_id, draft]));
  return (data ?? []).map((test) => {
    const draft = draftByTest.get(test.id);
    if (!draft) return { ...test, has_draft_changes: false, draft_version: null };
    return {
      ...test,
      has_draft_changes:
        test.status === 'published' &&
        Boolean(test.current_revision_id) &&
        draft.content_hash !== test.content_hash,
      draft_version: draft.draft_version,
      slug: draft.slug,
      title: draft.title,
      description: draft.description,
      icon: draft.icon,
      seo: draft.seo,
      duration_minutes: draft.duration_minutes,
      pass_score: draft.pass_score,
      jurisdiction: draft.jurisdiction,
      effective_date: draft.effective_date,
      sources: draft.sources,
      content_hash: draft.content_hash,
      updated_at: draft.updated_at,
    };
  });
}

export async function getTestEditorPayload(testId: string) {
  const actor = await requireCapability('test.manage');
  const admin = createAdminClient();
  const [{ data, error }, revisions, current] = await Promise.all([
    (await createClient()).rpc('get_course_editor_payload_v3', {
      p_actor_id: actor.user.id,
      p_test_id: testId,
    }),
    admin
      .from('test_revisions')
      .select('id,version,published_at,content_hash,presentation_id')
      .eq('test_id', testId)
      .order('version', { ascending: false })
      .limit(100),
    admin.from('tests').select('current_revision_id').eq('id', testId).maybeSingle(),
  ]);
  if (error) throw error;
  if (revisions.error || current.error) throw revisions.error ?? current.error;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('COURSE_EDITOR_PAYLOAD_INVALID');
  }
  return {
    ...(data as Record<string, unknown>),
    revisionHistory: (revisions.data ?? []).map((revision) => ({
      id: revision.id,
      version: revision.version,
      publishedAt: revision.published_at,
      contentHash: revision.content_hash,
      presentationId: revision.presentation_id,
      current: revision.id === current.data?.current_revision_id,
    })),
  };
}

export async function saveTest(values: SaveTestValues) {
  const actor = await requireCapability('test.manage');
  let previousPublishedSlug: string | null = null;
  if (values.id) {
    const current = await createAdminClient()
      .from('tests')
      .select('slug,current_revision_id')
      .eq('id', values.id)
      .maybeSingle();
    if (current.error) throw current.error;
    if (!current.data) throw new Error('TEST_NOT_FOUND');
    if (current.data.current_revision_id) previousPublishedSlug = current.data.slug;
  }
  const mutationArgs = {
    p_actor_id: actor.user.id,
    p_test_id: values.id ?? null,
    p_expected_version: values.draftVersion ?? null,
    p_slug: values.slug,
    p_title: values.title,
    p_description: values.description,
    p_icon: values.icon,
    p_display_order: values.displayOrder,
    p_presentation_id: values.presentationId,
    p_duration_minutes: values.durationMinutes,
    p_pass_score: values.passScore,
    p_attempts_per_calendar_day: values.attemptsPerCalendarDay,
    p_attempt_reset_timezone: values.attemptResetTimezone,
    p_question_variants: values.questionVariants as unknown as Json,
    p_seo: values.seo as unknown as Json,
    p_content_metadata: {
      jurisdiction: values.jurisdiction,
      effectiveDate: values.effectiveDate,
      sources: values.sources,
    } as unknown as Json,
  };
  const saved = (await authenticatedRpc(
    values.publish ? 'save_and_publish_course_v3' : 'save_course_draft_v3',
    mutationArgs,
  )) as Record<string, unknown>;
  if (
    typeof saved.id !== 'string' ||
    typeof saved.slug !== 'string' ||
    typeof saved.contentHash !== 'string' ||
    typeof saved.draftVersion !== 'number'
  ) {
    throw new Error('COURSE_DRAFT_RESULT_INVALID');
  }

  if (values.publish) {
    invalidateTestContent(values.slug);
    if (previousPublishedSlug && previousPublishedSlug !== values.slug) {
      invalidateTestContent(previousPublishedSlug);
    }
  }
  return saved;
}

export async function setTestStatus(testId: string, status: 'draft' | 'published') {
  const actor = await requireCapability('test.manage');
  const client = await createClient();
  const slugResult = await createAdminClient()
    .from('tests')
    .select('slug')
    .eq('id', testId)
    .maybeSingle();
  const response = await client.rpc('set_test_status', {
    p_actor_id: actor.user.id,
    p_test_id: testId,
    p_status: status,
  });
  unwrapRpcMutationResponse(response);
  invalidateTestContent(slugResult.data?.slug);
}

export async function deleteCourse(testId: string, expectedVersion: number) {
  const actor = await requireCapability('test.manage');
  const slugResult = await createAdminClient()
    .from('tests')
    .select('slug')
    .eq('id', testId)
    .maybeSingle();
  await authenticatedRpc('delete_course', {
    p_actor_id: actor.user.id,
    p_test_id: testId,
    p_expected_version: expectedVersion,
  });
  invalidateTestContent(slugResult.data?.slug);
}

export async function getAdminLearningHistory(targetUserId: string) {
  const actor = await requireCapability('results.delete');
  const { data, error } = await untypedClient(await createClient()).rpc(
    'get_admin_learning_history',
    { p_actor_id: actor.user.id, p_target_user_id: targetUserId },
  );
  if (error) throw new Error(error.message);
  const value = data as AdminLearningHistory | null;
  if (!value?.user || value.user.id !== targetUserId || !value.counts) {
    throw new Error('LEARNING_HISTORY_CONTRACT_INVALID');
  }
  return value;
}

export async function deleteAdminLearningHistory(
  targetUserId: string,
  reason: string,
  idempotencyKey: string,
) {
  const actor = await requireCapability('results.delete');
  let value: AdminLearningHistoryDeletion;
  // Invalidate both before and after the RPC so a response lost after commit
  // cannot leave an old QR verification projection warm.
  invalidateCertificateVerificationCache();
  try {
    value = (await authenticatedRpc('delete_admin_learning_history', {
      p_actor_id: actor.user.id,
      p_target_user_id: targetUserId,
      p_reason: reason,
      p_idempotency_key: idempotencyKey,
    })) as AdminLearningHistoryDeletion;
  } finally {
    invalidateCertificateVerificationCache();
    revalidatePath('/admin/employees');
    revalidatePath('/admin/results');
  }
  if (!value || value.targetUserId !== targetUserId || typeof value.deleted !== 'boolean') {
    throw new Error('LEARNING_HISTORY_DELETE_CONTRACT_INVALID');
  }
  return value;
}

export async function prepareCourseCatalogBatch(testIds: string[]) {
  const actor = await requireCapability('test.manage');
  const value = (await authenticatedRpc('prepare_course_catalog_batch', {
    p_actor_id: actor.user.id,
    p_test_ids: testIds,
  })) as Partial<PreparedCourseCatalogBatch> | null;
  if (
    !value ||
    typeof value.batchId !== 'string' ||
    !UUID_PATTERN.test(value.batchId) ||
    value.status !== 'staging' ||
    value.courseCount !== 5
  ) {
    throw new Error('COURSE_CATALOG_BATCH_RESULT_INVALID');
  }
  return value as PreparedCourseCatalogBatch;
}

function isCatalogCountRecord(value: unknown, expected: Record<string, number>) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.entries(expected).every(([key, count]) => record[key] === count);
}

function isNonNegativeCountRecord(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return keys.every((key) => Number.isInteger(record[key]) && Number(record[key]) >= 0);
}

export async function activateCourseCatalogBatch(batchId: string, idempotencyKey: string) {
  const actor = await requireCapability('test.manage');
  let value: Partial<ActivatedCourseCatalogBatch> | null;
  try {
    value = (await authenticatedRpc('activate_course_catalog_batch', {
      p_actor_id: actor.user.id,
      p_batch_id: batchId,
      p_idempotency_key: idempotencyKey,
    })) as Partial<ActivatedCourseCatalogBatch> | null;
  } finally {
    // A transport failure is ambiguous: the SQL transaction may already have
    // committed. Purging projections is safe even for a rejected activation.
    invalidateTestContent();
    invalidateCertificateVerificationCache();
    revalidatePath('/admin/courses');
    revalidatePath('/admin/results');
  }
  if (
    !value ||
    value.batchId !== batchId ||
    value.activationId !== idempotencyKey ||
    value.status !== 'activated' ||
    typeof value.replayed !== 'boolean' ||
    value.maintenanceEnabled !== true ||
    typeof value.catalogChecksum !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.catalogChecksum) ||
    !isCatalogCountRecord(value.published, {
      courses: 5,
      revisions: 5,
      variants: 15,
      questions: 150,
      options: 600,
    }) ||
    !isNonNegativeCountRecord(value.deleted, [
      'courses',
      'attempts',
      'attestations',
      'certificates',
      'certificateExportJobs',
    ]) ||
    !isNonNegativeCountRecord(value.preserved, ['authUsers', 'profiles'])
  ) {
    throw new Error('COURSE_CATALOG_ACTIVATION_RESULT_INVALID');
  }
  return value as ActivatedCourseCatalogBatch;
}

export async function setCourseCatalogMaintenance(enabled: boolean) {
  const actor = await requireCapability('test.manage');
  const value = (await authenticatedRpc('set_course_catalog_maintenance', {
    p_actor_id: actor.user.id,
    p_enabled: enabled,
  })) as Partial<CourseCatalogMaintenance> | null;
  if (
    !value ||
    value.enabled !== enabled ||
    typeof value.changed !== 'boolean' ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new Error('COURSE_CATALOG_MAINTENANCE_RESULT_INVALID');
  }
  return value as CourseCatalogMaintenance;
}

export async function getCourseCatalogMaintenance() {
  const actor = await requireCapability('test.manage');
  const { data, error } = await untypedClient(await createClient()).rpc(
    'get_course_catalog_maintenance',
    { p_actor_id: actor.user.id },
  );
  if (error) throw new Error(error.message);
  const value = data as Partial<CourseCatalogMaintenanceState> | null;
  if (
    !value ||
    typeof value.enabled !== 'boolean' ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new Error('COURSE_CATALOG_MAINTENANCE_RESULT_INVALID');
  }
  return value as CourseCatalogMaintenanceState;
}

export async function retireCoursePresentation(courseId: string, presentationId: string) {
  const actor = await requireCapability('test.manage');
  const value = (await authenticatedRpc('retire_course_presentation', {
    p_actor_id: actor.user.id,
    p_course_id: courseId,
    p_presentation_id: presentationId,
  })) as Partial<CoursePresentationRetirement> | null;
  if (
    !value ||
    value.courseId !== courseId ||
    value.presentationId !== presentationId ||
    value.status !== 'retired' ||
    typeof value.changed !== 'boolean' ||
    typeof value.retiredAt !== 'string' ||
    !Number.isFinite(Date.parse(value.retiredAt))
  ) {
    throw new Error('COURSE_PRESENTATION_RETIRE_RESULT_INVALID');
  }
  return value as CoursePresentationRetirement;
}

export async function deleteUnusedContentAsset(assetId: string) {
  const actor = await requireCapability('content.manage');
  await authenticatedRpc('mark_content_asset_orphan', {
    p_actor_id: actor.user.id,
    p_asset_id: assetId,
  });
  const prepared = (await authenticatedRpc('delete_verified_orphan_asset', {
    p_actor_id: actor.user.id,
    p_asset_id: assetId,
  })) as Record<string, unknown>;
  const storageKey = prepared.storageKey;
  if (typeof storageKey !== 'string' || !/^[0-9a-f]{2}\/[0-9a-f]{64}[.]webp$/u.test(storageKey)) {
    throw new Error('CONTENT_ASSET_DELETE_CONTRACT_INVALID');
  }

  const admin = createAdminClient();
  const removed = await admin.storage.from('content-media').remove([storageKey]);
  if (removed.error) {
    await admin
      .from('content_assets')
      .update({ status: 'orphan_candidate' })
      .eq('id', assetId)
      .eq('status', 'delete_pending');
    throw removed.error;
  }
  const deleted = await admin
    .from('content_assets')
    .delete()
    .eq('id', assetId)
    .eq('status', 'delete_pending')
    .select('id')
    .maybeSingle();
  if (deleted.error || deleted.data?.id !== assetId) {
    throw deleted.error ?? new Error('CONTENT_ASSET_DELETE_INCOMPLETE');
  }
}

export async function setAdminCapabilities(
  userId: string,
  capabilities: AdminCapability[],
  reason: string,
  metadata: AdminRequestMetadata,
) {
  await requireRole(['admin']);
  await requireCapability('capability.manage');
  const result = await authenticatedRpc('set_user_capabilities_confirmed', {
    p_target_id: userId,
    p_capabilities: capabilities,
    p_reason: reason,
    ...metadataArgs(metadata),
  });
  if (!Array.isArray(result) || !result.every((value) => typeof value === 'string')) {
    throw new Error('CAPABILITY_RESULT_INVALID');
  }
  return result as AdminCapability[];
}

function requiredString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (typeof value !== 'string' || !value) throw new Error('OUTBOX_PAYLOAD_INVALID');
  return value;
}

async function claimOutbox(
  operationId: string,
  reason: string,
  metadata: AdminRequestMetadata,
): Promise<ClaimedOutbox> {
  const value = (await authenticatedRpc('claim_auth_admin_operation_confirmed', {
    p_operation_id: operationId,
    p_reason: reason,
    ...metadataArgs(metadata),
  })) as Partial<ClaimedOutbox> | null;
  if (
    !value ||
    value.operationId !== operationId ||
    !UUID_PATTERN.test(value.operationId) ||
    typeof value.completionToken !== 'string' ||
    !OUTBOX_COMPLETION_TOKEN_PATTERN.test(value.completionToken) ||
    !['invite', 'suspend', 'restore'].includes(String(value.operationType)) ||
    !['prepared', 'external_succeeded', 'retryable'].includes(String(value.state)) ||
    (value.externalTargetId !== null &&
      (typeof value.externalTargetId !== 'string' || !UUID_PATTERN.test(value.externalTargetId))) ||
    !value.payload ||
    typeof value.payload !== 'object' ||
    Array.isArray(value.payload)
  ) {
    throw new Error('OUTBOX_CLAIM_INVALID');
  }
  return value as ClaimedOutbox;
}

function passwordContextAlreadyExists(error: unknown) {
  return externalErrorMessage(error).toLowerCase().includes('duplicate key');
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function inviteUserMatches(
  user: {
    email?: string | null;
    user_metadata?: Record<string, unknown> | null;
  },
  email: string,
  inviteCorrelation: string,
) {
  return (
    typeof user.email === 'string' &&
    normalizeEmail(user.email) === normalizeEmail(email) &&
    user.user_metadata?.safetyhubInviteCorrelation === inviteCorrelation
  );
}

export async function reconcileAuthAdminOperation(
  operationId: string,
  reason: string,
  metadata: AdminRequestMetadata,
) {
  await requireRole(['admin']);
  await requireCapability('capability.manage');
  await consumeCoarseQuota('admin.reconcile', metadata.ipHash);
  const operation = await claimOutbox(operationId, reason, metadata);
  const handle: OutboxHandle = operation;
  const admin = createAdminClient();
  let externalTargetId = operation.externalTargetId;
  const affectsCertificateVisibility =
    operation.operationType === 'suspend' || operation.operationType === 'restore';
  if (affectsCertificateVisibility) {
    // The prepared local state is authoritative even while Auth reconciliation
    // is pending, so remove any projection cached before this retry begins.
    invalidateCertificateVerificationCache();
  }
  try {
    if (operation.operationType === 'invite') {
      const email = requiredString(operation.payload, 'email');
      const passwordTicket = requiredString(operation.payload, 'passwordTicket');
      // Never trust a persisted request-derived origin during an outbox retry.
      // Resolve the deployment's canonical origin again at execution time.
      const origin = getSiteUrl().replace(/\/$/, '');
      const inviteCorrelation = requiredString(operation.payload, 'inviteCorrelation');
      let resolvedUserId = operation.externalTargetId;
      if (resolvedUserId) {
        const lookup = await admin.auth.admin.getUserById(resolvedUserId);
        if (lookup.error) throw lookup.error;
        if (!inviteUserMatches(lookup.data.user, email, inviteCorrelation)) {
          throw new Error('OUTBOX_INVITE_TARGET_MISMATCH');
        }
        resolvedUserId = lookup.data.user.id;
      }
      if (!resolvedUserId) {
        const invite = await admin.auth.admin.inviteUserByEmail(email, {
          data: {
            name: requiredString(operation.payload, 'name'),
            surname: requiredString(operation.payload, 'surname'),
            job: requiredString(operation.payload, 'job'),
            safetyhubInviteCorrelation: inviteCorrelation,
          },
          redirectTo: `${origin}/auth/invite?ticket=${encodeURIComponent(passwordTicket)}`,
        });
        if (invite.error) throw invite.error;
        resolvedUserId = invite.data.user.id;
      }
      externalTargetId = resolvedUserId;
      if (operation.state !== 'external_succeeded') {
        await advanceOutbox(handle, 'external_succeeded', externalTargetId);
      }
      try {
        await createPendingInviteContext(externalTargetId, passwordTicket);
      } catch (error) {
        if (!passwordContextAlreadyExists(error)) throw error;
      }
    } else if (operation.operationType === 'suspend' || operation.operationType === 'restore') {
      externalTargetId = requiredString(operation.payload, 'targetId');
      const update = await admin.auth.admin.updateUserById(externalTargetId, {
        ban_duration: operation.operationType === 'suspend' ? '876000h' : 'none',
      });
      if (update.error) throw update.error;
      if (operation.state !== 'external_succeeded') {
        await advanceOutbox(handle, 'external_succeeded', externalTargetId);
      }
    }
    await advanceOutbox(handle, 'committed', externalTargetId);
    return { ok: true };
  } catch (error) {
    await advanceOutbox(handle, 'retryable', externalTargetId, error);
    throw error;
  } finally {
    if (affectsCertificateVisibility) {
      // Also cover lost commit responses and failures while marking retryable.
      invalidateCertificateVerificationCache();
    }
  }
}
