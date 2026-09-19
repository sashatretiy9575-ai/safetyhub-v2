/**
 * The filters of an admin list, and the way back to them from an editor.
 *
 * A list keeps its filters in the URL. An editor replaces its own URL several
 * times (a saved slug, a publication notice), so a parameter carried through it
 * would have to survive every one of those. The list remembers its query in the
 * tab's session storage instead, and the editor's way back reads it. Whatever
 * is read is parsed again against this whitelist: a stored string is input.
 */
export const ADMIN_LIST_STATUSES = ['draft', 'published'] as const;
export type AdminListStatus = (typeof ADMIN_LIST_STATUSES)[number];
export type AdminListFilters = { q: string; status: AdminListStatus | '' };

export const ADMIN_LIST_PATHS = ['/admin/courses', '/admin/articles'] as const;
export type AdminListPath = (typeof ADMIN_LIST_PATHS)[number];

export const ADMIN_LIST_QUERY_MAX = 100;

type ParamValue = string | string[] | undefined;

/** A repeated parameter arrives as an array; the first value is the one the form sent. */
function first(value: ParamValue): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

export function readListFilters(params: Record<string, ParamValue>): AdminListFilters {
  const status = first(params.status);
  return {
    q: first(params.q).trim().slice(0, ADMIN_LIST_QUERY_MAX),
    status: (ADMIN_LIST_STATUSES as readonly string[]).includes(status)
      ? (status as AdminListStatus)
      : '',
  };
}

/** The canonical query string, without the question mark; empty filters are left out. */
export function listQuery(filters: AdminListFilters): string {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.status) params.set('status', filters.status);
  return params.toString();
}

export function listHref(basePath: AdminListPath, query: string): string {
  return query ? `${basePath}?${query}` : basePath;
}

/** Whatever was stored comes back as a query this module would have written itself. */
export function parseListQuery(raw: string | null | undefined): string {
  if (!raw) return '';
  const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
  return listQuery(
    readListFilters({ q: params.get('q') ?? undefined, status: params.get('status') ?? undefined }),
  );
}

export function listStorageKey(basePath: AdminListPath): string {
  return `safetyhub:admin-list:${basePath}`;
}
