/**
 * Route matching for the navigation highlight.
 *
 * This was the only JavaScript module in the tree, so both functions arrived at
 * their call sites as `any` — in a project that compiles with `strict` and
 * `noUncheckedIndexedAccess`.
 */
export function normalizeRoutePath(path: string | null | undefined): string {
  const value = (path || '/').trim();
  if (!value || value === '/') return '/';
  return value.replace(/\/+$/, '') || '/';
}

export function isRouteActive(pathname: string | null | undefined, href: string): boolean {
  const current = normalizeRoutePath(pathname);
  const target = normalizeRoutePath(href);

  if (target === '/') {
    return current === '/';
  }

  return current === target || current.startsWith(`${target}/`);
}
