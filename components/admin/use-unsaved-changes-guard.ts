'use client';

import { useCallback, useEffect, useRef } from 'react';

const LEAVE_WARNING =
  'Изменения сохранены только на этом устройстве. Покинуть редактор без сохранения на сервере?';

export function useUnsavedChangesGuard(dirty: boolean) {
  const navigationApprovedRef = useRef(false);
  const historyBounceRef = useRef(false);

  useEffect(() => {
    if (!dirty) return;
    navigationApprovedRef.current = false;

    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (navigationApprovedRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const guardLinkNavigation = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !(event.target instanceof Element)
      ) {
        return;
      }
      const anchor = event.target.closest<HTMLAnchorElement>('a[href]');
      if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
      const target = new URL(anchor.href, window.location.href);
      const current = new URL(window.location.href);
      if (
        target.origin !== current.origin ||
        (target.pathname === current.pathname && target.search === current.search)
      ) {
        return;
      }
      if (!window.confirm(LEAVE_WARNING)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      navigationApprovedRef.current = true;
    };
    const guardHistoryNavigation = () => {
      if (historyBounceRef.current) {
        historyBounceRef.current = false;
        return;
      }
      if (navigationApprovedRef.current) return;
      if (!window.confirm(LEAVE_WARNING)) {
        historyBounceRef.current = true;
        window.history.go(1);
        return;
      }
      navigationApprovedRef.current = true;
    };

    window.addEventListener('beforeunload', warnBeforeUnload);
    window.addEventListener('popstate', guardHistoryNavigation);
    document.addEventListener('click', guardLinkNavigation, true);
    return () => {
      window.removeEventListener('beforeunload', warnBeforeUnload);
      window.removeEventListener('popstate', guardHistoryNavigation);
      document.removeEventListener('click', guardLinkNavigation, true);
    };
  }, [dirty]);

  return useCallback(() => {
    navigationApprovedRef.current = true;
  }, []);
}
