'use client';

import { useEffect, useState } from 'react';
import {
  listHref,
  listStorageKey,
  parseListQuery,
  type AdminListPath,
} from '@/lib/admin/list-return';

/** The list remembers the query it is showing, so an editor can lead back to it. */
export function rememberAdminListQuery(basePath: AdminListPath, query: string) {
  try {
    sessionStorage.setItem(listStorageKey(basePath), query);
  } catch {
    // A private window without storage leads back to the unfiltered list.
  }
}

/**
 * Where «Назад» and a finished deletion lead: the list as it was left. The
 * plain path is rendered first — the server has no session storage — and the
 * remembered filters join it after mount.
 */
export function useAdminListHref(basePath: AdminListPath): string {
  const [href, setHref] = useState<string>(basePath);
  useEffect(() => {
    try {
      setHref(listHref(basePath, parseListQuery(sessionStorage.getItem(listStorageKey(basePath)))));
    } catch {
      setHref(basePath);
    }
  }, [basePath]);
  return href;
}
