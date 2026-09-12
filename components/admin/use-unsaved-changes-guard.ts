'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { confirmDialog } from '@/components/admin/confirm-dialog';

const LEAVE_WARNING =
  'Изменения сохранены только на этом устройстве. Покинуть редактор без сохранения на сервере?';

function askToLeave() {
  return confirmDialog({
    title: 'Покинуть редактор?',
    description: LEAVE_WARNING,
    confirmLabel: 'Покинуть',
    busyLabel: 'Выходим…',
  });
}

export function useUnsavedChangesGuard(dirty: boolean) {
  const router = useRouter();
  const navigationApprovedRef = useRef(false);
  const historyBounceRef = useRef(false);
  const askingRef = useRef(false);

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
      // The dialog is asynchronous, so the click is always stopped here and
      // the navigation is replayed through the router once it is confirmed.
      event.preventDefault();
      event.stopPropagation();
      if (askingRef.current) return;
      askingRef.current = true;
      void askToLeave().then((confirmed) => {
        askingRef.current = false;
        if (!confirmed) return;
        navigationApprovedRef.current = true;
        router.push(`${target.pathname}${target.search}${target.hash}`);
      });
    };
    const guardHistoryNavigation = () => {
      if (historyBounceRef.current) {
        historyBounceRef.current = false;
        return;
      }
      if (navigationApprovedRef.current) return;
      // Bounce back first, then ask; a confirmed answer replays the back step.
      historyBounceRef.current = true;
      window.history.go(1);
      if (askingRef.current) return;
      askingRef.current = true;
      void askToLeave().then((confirmed) => {
        askingRef.current = false;
        if (!confirmed) return;
        navigationApprovedRef.current = true;
        window.history.back();
      });
    };

    window.addEventListener('beforeunload', warnBeforeUnload);
    window.addEventListener('popstate', guardHistoryNavigation);
    document.addEventListener('click', guardLinkNavigation, true);
    return () => {
      window.removeEventListener('beforeunload', warnBeforeUnload);
      window.removeEventListener('popstate', guardHistoryNavigation);
      document.removeEventListener('click', guardLinkNavigation, true);
    };
  }, [dirty, router]);

  return useCallback(() => {
    navigationApprovedRef.current = true;
  }, []);
}
