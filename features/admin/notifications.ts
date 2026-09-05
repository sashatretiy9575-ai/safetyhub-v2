import 'server-only';

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { requireAnyCapability } from '@/features/auth/server';
import {
  adminNotificationEventSchema,
  type AdminNotificationEvent,
  type AdminNotificationPage,
} from '@/features/admin/notification-contract';
import { createClient } from '@/lib/supabase/server';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';

type RpcError = { message: string; code?: string };
type NotificationRpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
};

function rpcClient(client: unknown) {
  return client as NotificationRpcClient;
}

async function authenticatedRpc(name: string, args: Record<string, unknown>) {
  return rpcClient(await createClient()).rpc(name, args);
}

const INBOX_CAPABILITIES = ['notifications.read', 'audit.read'] as const;

// The envelope stays strict, but each item is validated on its own: one
// malformed payload (for example, a legacy schema left in the table) must not
// take the whole inbox down with NOTIFICATION_INBOX_RESPONSE_INVALID.
const rpcEnvelopeSchema = z
  .object({
    items: z.array(z.unknown()).max(50),
    unread: z.number().int().min(0),
    serverNow: z.string().datetime({ offset: true }),
  })
  .strict();

export async function listAdminNotificationInbox(input: {
  limit: number;
  beforeOccurredAt: string | null;
  beforeId: string | null;
}) {
  await requireAnyCapability(INBOX_CAPABILITIES);
  const requestedLimit = Math.min(49, Math.max(1, input.limit));
  const response = await authenticatedRpc('list_admin_notification_inbox', {
    p_limit: requestedLimit + 1,
    p_before_occurred_at: input.beforeOccurredAt,
    p_before_id: input.beforeId,
  });
  if (response.error) throw new Error(response.error.message);
  const envelope = rpcEnvelopeSchema.safeParse(response.data);
  if (!envelope.success) throw new Error('NOTIFICATION_INBOX_RESPONSE_INVALID');
  const validItems: AdminNotificationEvent[] = [];
  for (const candidate of envelope.data.items) {
    const item = adminNotificationEventSchema.safeParse(candidate);
    if (item.success) {
      validItems.push(item.data);
    } else {
      console.error('NOTIFICATION_INBOX_ITEM_INVALID', {
        id:
          candidate && typeof candidate === 'object' && 'id' in candidate
            ? (candidate as { id?: unknown }).id
            : undefined,
      });
    }
  }

  const hasMore = envelope.data.items.length > requestedLimit;
  const items = validItems.slice(0, requestedLimit);
  const lastItem = items.at(-1);
  const page: AdminNotificationPage = {
    items,
    unread: envelope.data.unread,
    serverNow: envelope.data.serverNow,
    hasMore,
    nextCursor: hasMore && lastItem ? { occurredAt: lastItem.occurredAt, id: lastItem.id } : null,
  };
  const etag = `"notification-${createHash('sha256')
    .update(JSON.stringify(page), 'utf8')
    .digest('base64url')}"`;
  return { page, etag };
}

export async function markAdminNotificationsRead(eventIds: string[]) {
  await requireAnyCapability(INBOX_CAPABILITIES);
  const value = unwrapRpcMutationResponse(
    await authenticatedRpc('mark_admin_notifications_read', {
      p_event_ids: eventIds,
    }),
  ) as Partial<{ marked: number }> | null;
  if (!value || !Number.isInteger(value.marked) || Number(value.marked) < 0) {
    throw new Error('NOTIFICATION_MARK_READ_RESPONSE_INVALID');
  }
  return { marked: Number(value.marked) };
}

export async function markAllAdminNotificationsRead() {
  await requireAnyCapability(INBOX_CAPABILITIES);
  const value = unwrapRpcMutationResponse(
    await authenticatedRpc('mark_all_admin_notifications_read', {}),
  ) as Partial<{ marked: number }> | null;
  if (!value || !Number.isInteger(value.marked) || Number(value.marked) < 0) {
    throw new Error('NOTIFICATION_MARK_READ_RESPONSE_INVALID');
  }
  return { marked: Number(value.marked) };
}

export async function retryAdminNotificationDelivery(eventId: string) {
  await requireAnyCapability(INBOX_CAPABILITIES);
  const value = unwrapRpcMutationResponse(
    await authenticatedRpc('retry_admin_notification_delivery', {
      p_event_id: eventId,
    }),
  ) as Partial<{ eventId: string; status: string }> | null;
  if (!value || value.eventId !== eventId || value.status !== 'retry') {
    throw new Error('NOTIFICATION_RETRY_RESPONSE_INVALID');
  }
  return { eventId, status: 'retry' as const };
}
