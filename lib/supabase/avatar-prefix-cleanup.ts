import 'server-only';

import type { createAdminClient } from '@/lib/supabase/admin';

const AVATAR_BUCKET = 'profile-avatars';
const LIST_PAGE_SIZE = 100;
const MAX_LIST_REQUESTS = 256;
const MAX_OBJECTS = 5_000;

type AdminClient = ReturnType<typeof createAdminClient>;

async function listFolder(client: AdminClient, prefix: string) {
  const keys: string[] = [];
  let offset = 0;
  for (let request = 0; request < MAX_LIST_REQUESTS; request += 1) {
    const { data, error } = await client.storage.from(AVATAR_BUCKET).list(prefix, {
      limit: LIST_PAGE_SIZE,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw error;
    const page = data ?? [];
    for (const entry of page) {
      // A folder placeholder has no id; only real objects can be removed.
      if (entry.id) keys.push(`${prefix}/${entry.name}`);
    }
    if (page.length < LIST_PAGE_SIZE) break;
    offset += page.length;
    if (keys.length >= MAX_OBJECTS) break;
  }
  return keys;
}

/**
 * Removes every avatar object an account owns.
 *
 * Deleting the account itself is a database transaction; the bytes in Storage
 * are not part of it. The reconciler would eventually sweep the prefix, but it
 * has no schedule, so the application clears it directly after the purge
 * commits. `storage.list` is not recursive, hence the two known folders.
 *
 * Best effort by design: the tombstone stays in `post_purge_cleanup`, so a
 * failure here leaves orphaned bytes for the reconciler rather than failing a
 * deletion the database has already committed.
 */
export async function removeAvatarPrefix(client: AdminClient, userId: string) {
  const keys = [
    ...(await listFolder(client, userId)),
    ...(await listFolder(client, `${userId}/objects`)),
  ];
  for (let offset = 0; offset < keys.length; offset += LIST_PAGE_SIZE) {
    const batch = keys.slice(offset, offset + LIST_PAGE_SIZE);
    const { error } = await client.storage.from(AVATAR_BUCKET).remove(batch);
    if (error) throw error;
  }
  return keys.length;
}
