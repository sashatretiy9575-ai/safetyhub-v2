import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import type { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Database } from '@/lib/supabase/types';

export type PasswordChangeContextKind = 'recovery' | 'invite';
export type PasswordChangeContext = {
  kind: PasswordChangeContextKind;
  token: string;
};

const PASSWORD_CONTEXT_COOKIE = 'safetyhub-password-context';
const CONTEXT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTEXT_COOKIE_SECONDS = 15 * 60;
const INVITE_LINK_SECONDS = 24 * 60 * 60;

type RpcError = { message: string };
type PasswordContextRpcClient = {
  rpc(
    name: string,
    values: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
};

function contextClient() {
  return createAdminClient() as unknown as PasswordContextRpcClient;
}

async function rpc<T>(name: string, values: Record<string, unknown>) {
  const { data, error } = await contextClient().rpc(name, values);
  if (error) throw new Error(error.message);
  return data as T;
}

export function newPasswordContextToken() {
  return randomBytes(32).toString('base64url');
}

function contextTokenHash(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function validContextToken(token: string | null | undefined): token is string {
  return typeof token === 'string' && CONTEXT_TOKEN_PATTERN.test(token);
}

async function createContext(
  kind: PasswordChangeContextKind,
  ttlSeconds: number,
  userId: string | null,
  sessionId: string | null,
  suppliedToken?: string,
) {
  const token = suppliedToken ?? newPasswordContextToken();
  if (!validContextToken(token)) throw new Error('PASSWORD_CONTEXT_TOKEN_INVALID');
  await rpc('create_password_change_context', {
    p_token_hash: contextTokenHash(token),
    p_user_id: userId,
    p_context_kind: kind,
    p_session_id: sessionId,
    p_expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  });
  return token;
}

export { createEphemeralAuthClient } from '@/lib/supabase/ephemeral-auth';

export async function verifiedSessionId(
  client: SupabaseClient<Database>,
  accessToken: string,
  expectedUserId?: string,
) {
  const { data, error } = await client.auth.getClaims(accessToken);
  if (error) throw error;
  const sessionId = data?.claims.session_id;
  const subject = data?.claims.sub;
  if (
    typeof sessionId !== 'string' ||
    !SESSION_ID_PATTERN.test(sessionId) ||
    (expectedUserId !== undefined && subject !== expectedUserId)
  ) {
    throw new Error('AUTH_SESSION_ID_INVALID');
  }
  return sessionId;
}

export function createVerifiedRecoveryContext(userId: string, sessionId: string) {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('AUTH_SESSION_ID_INVALID');
  return createContext('recovery', CONTEXT_COOKIE_SECONDS, userId, sessionId);
}

export function createPendingInviteContext(userId: string, token?: string) {
  return createContext('invite', INVITE_LINK_SECONDS, userId, null, token);
}

export async function deletePasswordChangeContext(token: string) {
  if (!validContextToken(token)) return;
  await rpc('delete_password_change_context', { p_token_hash: contextTokenHash(token) });
}

export async function claimPasswordChangeContext(
  token: string,
  kind: PasswordChangeContextKind,
  userId: string,
  sessionId: string,
) {
  if (!validContextToken(token) || !SESSION_ID_PATTERN.test(sessionId)) return false;
  return Boolean(
    await rpc<boolean>('claim_password_change_context', {
      p_token_hash: contextTokenHash(token),
      p_context_kind: kind,
      p_user_id: userId,
      p_session_id: sessionId,
    }),
  );
}

async function passwordContextCookie() {
  return (await cookies()).get(PASSWORD_CONTEXT_COOKIE)?.value ?? null;
}

export async function inspectPasswordChangeContext(
  userId: string,
  sessionId: string,
): Promise<PasswordChangeContext | null> {
  const token = await passwordContextCookie();
  if (!validContextToken(token) || !SESSION_ID_PATTERN.test(sessionId)) return null;
  const kind = await rpc<string | null>('inspect_password_change_context', {
    p_token_hash: contextTokenHash(token),
    p_user_id: userId,
    p_session_id: sessionId,
  });
  if (kind !== 'recovery' && kind !== 'invite') return null;
  return { kind, token };
}

export async function consumePasswordChangeContext(
  userId: string,
  sessionId: string,
  expectedKind: PasswordChangeContextKind,
) {
  const token = await passwordContextCookie();
  if (!validContextToken(token) || !SESSION_ID_PATTERN.test(sessionId)) return false;
  const kind = await rpc<string | null>('consume_password_change_context', {
    p_token_hash: contextTokenHash(token),
    p_context_kind: expectedKind,
    p_user_id: userId,
    p_session_id: sessionId,
  });
  return kind === expectedKind;
}

export function setPasswordContextCookie(response: NextResponse, token: string) {
  if (!validContextToken(token)) throw new Error('PASSWORD_CONTEXT_TOKEN_INVALID');
  response.cookies.set(PASSWORD_CONTEXT_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // Recovery starts in an email client and returns through Supabase. Lax keeps
    // the one-time context available on that top-level cross-site navigation.
    sameSite: 'lax',
    path: '/',
    maxAge: CONTEXT_COOKIE_SECONDS,
  });
}

export function clearPasswordContextCookie(response: NextResponse) {
  response.cookies.set(PASSWORD_CONTEXT_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}
