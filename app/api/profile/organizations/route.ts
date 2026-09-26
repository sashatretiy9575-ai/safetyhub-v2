import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/server/auth/api-error';
import { requireUser } from '@/server/auth/session';
import { createClient } from '@/server/supabase/server';
import { normalizeProfileText } from '@/lib/validation/profile';

type OrganizationSearchRpcClient = {
  rpc: (
    name: 'search_profile_organizations',
    args: { p_query: string; p_limit: number },
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/**
 * Suggestions for the organization field. The database answers from three
 * characters, eight names at most, within a per-account budget
 * (`profile.organization.search`).
 */
export async function GET(request: Request) {
  try {
    await requireUser();
    const query = normalizeProfileText(new URL(request.url).searchParams.get('q') ?? '');
    if (query.length < 3 || query.length > 180) {
      return NextResponse.json({ organizations: [] });
    }
    const supabase = await createClient();
    const { data, error } = await (supabase as unknown as OrganizationSearchRpcClient).rpc(
      'search_profile_organizations',
      { p_query: query, p_limit: 8 },
    );
    if (error) {
      // An exhausted budget only means no suggestions: the person is typing and
      // can still enter the name by hand, so there is nothing to report.
      if (error.message.includes('RATE_LIMITED')) {
        return NextResponse.json({ organizations: [] });
      }
      throw error;
    }
    const organizations = Array.isArray(data)
      ? data.filter((item): item is string => typeof item === 'string').slice(0, 8)
      : [];
    return NextResponse.json({ organizations });
  } catch (error) {
    return apiError(error);
  }
}
