'use client';

import dynamic from 'next/dynamic';

/**
 * The account menu (Radix dropdown, avatar, install and theme items) is only
 * drawn for a signed-in visitor, but imported directly by the private layout
 * it shipped to every guest on the sign-in page as well. Loaded through
 * `next/dynamic` it is still rendered on the server for signed-in visitors and
 * never downloaded by guests.
 */
export const LazyUserMenu = dynamic(() =>
  import('@/components/shared/user-menu').then((module) => module.UserMenu),
);
