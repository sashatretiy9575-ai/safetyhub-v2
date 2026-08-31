import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { requireUser } from '@/features/auth/server';
import { createClient } from '@/lib/supabase/server';
import { normalizeProfileText } from '@/lib/validation/profile';

type OrganizationSearchRpcClient = {
  rpc: (
    name: 'search_profile_organizations',
    args: { p_query: string; p_limit: number },
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export async function GET(request: Request) {
  try {
    await requireUser();
    const query = normalizeProfileText(new URL(request.url).searchParams.get('q') ?? '');
    if (query.length < 2 || query.length > 180) {
      return NextResponse.json({ organizations: [] });
    }
    const supabase = await createClient();
    const { data, error } = await (supabase as unknown as OrganizationSearchRpcClient).rpc(
      'search_profile_organizations',
      { p_query: query, p_limit: 8 },
    );
    if (error) throw error;
    const organizations = Array.isArray(data)
      ? data.filter((item): item is string => typeof item === 'string').slice(0, 8)
      : [];
    return NextResponse.json({ organizations });
  } catch (error) {
    return apiError(error);
  }
}
