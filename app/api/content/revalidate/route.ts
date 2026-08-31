import { revalidatePath, revalidateTag } from 'next/cache';
import { NextResponse } from '@/lib/security/api-response';
import {
  ARTICLES_CACHE_TAG,
  CONTENT_CACHE_TAG,
  CONTENT_REVALIDATE_PATHS,
  TOPICS_CACHE_TAG,
} from '@/lib/content/cache-policy';
import { readJsonBody } from '@/lib/security/request-body';
import { matchesBearerSecret } from '@/lib/security/bearer-secret';

export const runtime = 'nodejs';

function authorized(request: Request) {
  return matchesBearerSecret(
    request.headers.get('authorization'),
    process.env.CONTENT_REVALIDATE_SECRET,
  );
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  const payload = (await readJsonBody(request, 4 * 1024).catch(() => null)) as {
    scope?: unknown;
    slug?: unknown;
  } | null;
  const scope = payload?.scope;
  if (scope !== undefined && scope !== 'all' && scope !== 'articles' && scope !== 'topics') {
    return NextResponse.json({ error: 'INVALID_SCOPE' }, { status: 400 });
  }
  const slug = typeof payload?.slug === 'string' ? payload.slug.trim() : '';
  if (slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return NextResponse.json({ error: 'INVALID_SLUG' }, { status: 400 });
  }

  revalidateTag(CONTENT_CACHE_TAG, 'max');
  if (!scope || scope === 'all' || scope === 'articles') {
    revalidateTag(ARTICLES_CACHE_TAG, 'max');
  }
  if (!scope || scope === 'all' || scope === 'topics') {
    revalidateTag(TOPICS_CACHE_TAG, 'max');
  }
  for (const path of CONTENT_REVALIDATE_PATHS) revalidatePath(path);
  if (slug) {
    revalidatePath(`/blog/${slug}`);
    revalidatePath(`/topics/${slug}`);
  }

  return NextResponse.json({ revalidated: true });
}
