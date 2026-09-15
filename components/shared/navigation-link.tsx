'use client';
import NextLink, { useLinkStatus } from 'next/link';
import type { ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import { RouteLoading } from './route-loading';

function PendingNavigation() {
  const { pending } = useLinkStatus();
  return pending && typeof document !== 'undefined' ? createPortal(<RouteLoading floating />, document.body) : null;
}
/** Pending is owned by the router: cancellation and failed transitions clear it too. */
export default function NavigationLink({ children, ...props }: ComponentProps<typeof NextLink>) {
  return <NextLink {...props}>{children}<PendingNavigation /></NextLink>;
}
