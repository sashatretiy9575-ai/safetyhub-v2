import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { AuthenticationError, requireUser } from '@/features/auth/server';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import { type AppLocale, localizePathname } from '@/i18n/config';
import { readJsonBody } from '@/lib/security/request-body';
import { createClient } from '@/lib/supabase/server';
import { clearSafetyHubLocalSession } from '@/lib/supabase/session-cleanup';

const requestSchema = z.object({ locale: z.enum(['ru', 'kk', 'en', 'zh']) }).strict();

/**
 * Kept at this URL for already-open bundles. The server, not the request
 * body, establishes the active realm through the actor-bound SQL function.
 */
export type LocaleTransitionResult =
  | { state: 'updated'; locale: AppLocale; redirectTo: string }
  | { state: 'signed_out'; locale: AppLocale; redirectTo: string };

function targetLoginPath(locale: AppLocale) {
  const login = locale === 'zh' ? '/zh/auth/login' : localizePathname('/auth/login', locale);
  // The target page is intentionally a neutral login screen, but it should
  // still explain why the prior browser session is gone after a realm change.
  return `${login}?realmChanged=1`;
}

function signedOutTransition(request: NextRequest, locale: AppLocale) {
  const payload: LocaleTransitionResult = {
    state: 'signed_out',
    locale,
    redirectTo: targetLoginPath(locale),
  };
  return clearSafetyHubLocalSession(request, NextResponse.json(payload));
}

function isRealmBoundaryError(error: { message?: string } | null) {
  const message = error?.message ?? '';
  return (
    message.includes('AUTH_REALM_LOCALE_MISMATCH') ||
    message.includes('AUTH_REALM_INVALID') ||
    message.includes('AUTH_REALM_USER_REQUIRED')
  );
}

export async function POST(request: NextRequest) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
    }
    const parsed = requestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }

    try {
      await requireUser({ enforceLegal: false });
    } catch (error) {
      // An invalid/stale cookie must never survive long enough for a target
      // realm to render over it. Suspension and active account decisions keep
      // their normal API error rather than silently changing account state.
      if (
        error instanceof AuthenticationError &&
        (error.code === 'UNAUTHENTICATED' || error.code === 'AUTH_CONTEXT_INCOMPLETE')
      ) {
        return signedOutTransition(request, parsed.data.locale);
      }
      throw error;
    }

    const supabase = await createClient();
    // The RPC is the one actor-authorized write. Do not race it with a second
    // auth.updateUser metadata write; the database rejects a crossed realm.
    const { error } = await supabase.rpc('set_preferred_locale', {
      p_locale: parsed.data.locale,
    });

    if (isRealmBoundaryError(error)) {
      return signedOutTransition(request, parsed.data.locale);
    }
    if (error) {
      return NextResponse.json({ error: 'LOCALE_SYNC_UNAVAILABLE' }, { status: 503 });
    }

    const payload: LocaleTransitionResult = {
      state: 'updated',
      locale: parsed.data.locale,
      redirectTo: localizePathname('/', parsed.data.locale),
    };
    return NextResponse.json(payload);
  } catch (error) {
    return apiError(error);
  }
}
