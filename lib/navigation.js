export function normalizeRoutePath(path) {
  const value = (path || '/').trim();
  if (!value || value === '/') return '/';
  return value.replace(/\/+$/, '') || '/';
}

export function isRouteActive(pathname, href) {
  const current = normalizeRoutePath(pathname);
  const target = normalizeRoutePath(href);

  if (target === '/') {
    return current === '/';
  }

  return current === target || current.startsWith(`${target}/`);
}
