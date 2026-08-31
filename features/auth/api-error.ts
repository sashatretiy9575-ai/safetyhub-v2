import { NextResponse } from '@/lib/security/api-response';
import { AuthenticationError } from './server';
import { RateLimitError } from '@/lib/security/rate-limit';
import { RequestBodyError } from '@/lib/security/request-body';
import { RpcMutationError } from '@/lib/supabase/rpc-mutation-result';

export function apiError(error: unknown) {
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
  if (message.includes('ALREADY_COMPLETED'))
    return NextResponse.json({ error: 'ATTEMPT_ALREADY_COMPLETED' }, { status: 409 });
  if (message.includes('COURSE_CATALOG_MAINTENANCE')) {
    return NextResponse.json({ error: 'COURSE_CATALOG_MAINTENANCE' }, { status: 503 });
  }
  if (message.includes('CATALOG_MAINTENANCE_REQUIRED')) {
    return NextResponse.json({ error: 'CATALOG_MAINTENANCE_REQUIRED' }, { status: 409 });
  }
  if (
    message.includes('ACCOUNT_HAS_PENDING_AUTH_OPERATIONS') ||
    message.includes('ACCOUNT_STORAGE_CLEANUP_PENDING') ||
    message.includes('ACCOUNT_STORAGE_CLEANUP_IN_PROGRESS') ||
    message.includes('ACCOUNT_PURGE_NOT_READY')
  ) {
    return NextResponse.json({ error: 'CONFLICT' }, { status: 409 });
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
