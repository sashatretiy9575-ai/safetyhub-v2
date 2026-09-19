import 'server-only';

import { NextResponse } from '@/lib/security/api-response';
import { AuthenticationError } from '@/server/auth/session';
import { RateLimitError } from '@/server/security/rate-limit';
import { RequestBodyError } from '@/lib/security/request-body';
import { RpcMutationError } from '@/server/supabase/rpc-mutation-result';

export function apiError(error: unknown) {
  const documentMessage =
    error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  if (documentMessage === 'DOCUMENT_PROFILE_REQUIRED')
    return NextResponse.json({ error: documentMessage }, { status: 409 });
  if (['DOCUMENT_FORMAL_EXAM_REQUIRED', 'DOCUMENT_FORMAL_EXAM_INVALID'].includes(documentMessage))
    return NextResponse.json({ error: documentMessage }, { status: 409 });
  if (
    /^DOCUMENT_REQUIRED_FIELDS:(?:orderNumber,orderDate,verificationKind|trainingReason|qualificationDecision|organization,position|education)$/u.test(
      documentMessage,
    )
  ) {
    return NextResponse.json(
      { error: 'DOCUMENT_REQUIRED_FIELDS', fields: documentMessage.split(':')[1]!.split(',') },
      { status: 409 },
    );
  }
  if (error instanceof AuthenticationError) {
    return NextResponse.json({ error: error.code }, { status: error.status });
  }
  if (error instanceof RateLimitError) {
    return NextResponse.json(
      { error: 'RATE_LIMITED', retryAfter: error.retryAfter },
      { status: 429, headers: { 'Retry-After': String(error.retryAfter) } },
    );
  }
  if (error instanceof RequestBodyError) {
    return NextResponse.json(
      { error: error.code === 'PAYLOAD_TOO_LARGE' ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST' },
      { status: error.status },
    );
  }
  if (error instanceof RpcMutationError) {
    if (['ACCOUNT_APPROVAL_NOT_PENDING', 'IDEMPOTENCY_KEY_REUSED'].includes(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error.message === 'ACCOUNT_APPROVAL_SELF_DECISION_FORBIDDEN') {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error.message === 'COURSE_CATALOG_MAINTENANCE') {
      return NextResponse.json({ error: 'COURSE_CATALOG_MAINTENANCE' }, { status: 503 });
    }
    if (error.message === 'CATALOG_MAINTENANCE_REQUIRED') {
      return NextResponse.json({ error: 'CATALOG_MAINTENANCE_REQUIRED' }, { status: 409 });
    }
    if (
      [
        'LEARNING_HISTORY_ALREADY_DELETED',
        'LEARNING_HISTORY_DELETE_CONFLICT',
        'LEARNING_HISTORY_TARGET_NOT_ALLOWED',
      ].includes(error.message)
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error.code === '42501') {
      return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
    }
    if (error.code === 'P0002') {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    if (['23505', '55000', '40001', '40P01'].includes(error.code)) {
      return NextResponse.json({ error: 'CONFLICT' }, { status: 409 });
    }
    if (['23502', '23503', '23514', '23P01', '22003', '22007', '22023'].includes(error.code)) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
  }
  if (typeof error === 'object' && error && 'status' in error) {
    const status = Number((error as { status?: unknown }).status);
    if (status === 422 || status === 429) {
      return NextResponse.json(
        { error: status === 429 ? 'RATE_LIMITED' : 'REQUEST_REJECTED' },
        { status },
      );
    }
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' &&
          error &&
          'message' in error &&
          typeof error.message === 'string'
        ? error.message
        : 'UNKNOWN_ERROR';
  if (message.includes('NOT_FOUND'))
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  if (message.includes('SUSPENDED'))
    return NextResponse.json({ error: 'ACCOUNT_SUSPENDED' }, { status: 403 });
  if (message.includes('PASSWORDLESS_INVITE_RETIRED')) {
    return NextResponse.json({ error: 'PASSWORDLESS_INVITE_RETIRED' }, { status: 410 });
  }
  if (message.includes('ACCOUNT_APPROVAL_REQUIRED')) {
    return NextResponse.json({ error: 'ACCOUNT_APPROVAL_REQUIRED' }, { status: 403 });
  }
  if (message.includes('COURSE_ACCESS_REQUIRED')) {
    return NextResponse.json({ error: 'COURSE_ACCESS_REQUIRED' }, { status: 403 });
  }
  if (message.includes('LEGAL_ACCEPTANCE_REQUIRED')) {
    return NextResponse.json({ error: 'LEGAL_ACCEPTANCE_REQUIRED' }, { status: 403 });
  }
  if (message.includes('PROFILE_ONBOARDING_REQUIRED')) {
    return NextResponse.json({ error: 'PROFILE_ONBOARDING_REQUIRED' }, { status: 409 });
  }
  if (message.includes('AVATAR_REQUIRED')) {
    return NextResponse.json({ error: 'AVATAR_REQUIRED' }, { status: 409 });
  }
  if (message.includes('ALREADY_COMPLETED'))
    return NextResponse.json({ error: 'ATTEMPT_ALREADY_COMPLETED' }, { status: 409 });
  if (message.includes('COURSE_CATALOG_MAINTENANCE')) {
    return NextResponse.json({ error: 'COURSE_CATALOG_MAINTENANCE' }, { status: 503 });
  }
  if (message.includes('CATALOG_MAINTENANCE_REQUIRED')) {
    return NextResponse.json({ error: 'CATALOG_MAINTENANCE_REQUIRED' }, { status: 409 });
  }
  if (message.includes('NOTIFICATION_DELIVERY_NOT_RETRYABLE')) {
    return NextResponse.json({ error: 'NOTIFICATION_DELIVERY_NOT_RETRYABLE' }, { status: 409 });
  }
  if (
    message.includes('ACCOUNT_HAS_PENDING_AUTH_OPERATIONS') ||
    message.includes('ACCOUNT_STORAGE_CLEANUP_PENDING') ||
    message.includes('ACCOUNT_STORAGE_CLEANUP_IN_PROGRESS') ||
    message.includes('ACCOUNT_PURGE_NOT_READY')
  ) {
    return NextResponse.json({ error: 'CONFLICT' }, { status: 409 });
  }
  // Codes the operator interface explains in its own words. They have to keep
  // their identity: collapsing them into PROTECTED_OPERATION left the panel
  // unable to say which of its buttons is refusing and why.
  for (const code of [
    'IDEMPOTENCY_KEY_REUSED',
    'LAST_ACTIVE_ADMIN_PROTECTED',
    'CANNOT_DELETE_SELF',
  ]) {
    if (message.includes(code)) return NextResponse.json({ error: code }, { status: 409 });
  }
  if (
    message.includes('LAST_SUPERADMIN') ||
    message.includes('CANNOT_') ||
    message.includes('DEMOTE_SUPERADMIN') ||
    message.includes('DELETION_PENDING') ||
    message.includes('RESTORE_USER')
  ) {
    return NextResponse.json({ error: 'PROTECTED_OPERATION' }, { status: 409 });
  }
  if (
    message.includes('FORBIDDEN') ||
    message.includes('ADMIN_REQUIRED') ||
    message.includes('SUPERADMIN_REQUIRED') ||
    message.includes('CAPABILITY_REQUIRED')
  ) {
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
  }
  if (
    message.includes('INVALID') ||
    message.includes('CONFIRMATION_MISMATCH') ||
    message.includes('REQUIRED') ||
    message.includes('DUPLICATE')
  ) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }
  return NextResponse.json({ error: 'SERVER_ERROR' }, { status: 500 });
}
