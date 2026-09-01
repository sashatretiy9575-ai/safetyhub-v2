import 'server-only';

import { createHash } from 'node:crypto';
import { requireCapability } from '@/features/auth/server';
import {
  adminNotificationRpcPageSchema,
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

export async function listAdminNotificationInbox(input: {
  limit: number;
  beforeOccurredAt: string | null;
  beforeId: string | null;
}) {
  await requireCapability('audit.read');
  const requestedLimit = Math.min(49, Math.max(1, input.limit));
  const response = await authenticatedRpc('list_admin_notification_inbox', {
    p_limit: requestedLimit + 1,
    p_before_occurred_at: input.beforeOccurredAt,
    p_before_id: input.beforeId,
  });
  if (response.error) throw new Error(response.error.message);
  const parsed = adminNotificationRpcPageSchema.safeParse(response.data);
  if (!parsed.success) throw new Error('NOTIFICATION_INBOX_RESPONSE_INVALID');

  const hasMore = parsed.data.items.length > requestedLimit;
  const items = parsed.data.items.slice(0, requestedLimit);
  const lastItem = items.at(-1);
  const page: AdminNotificationPage = {
    items,
    unread: parsed.data.unread,
    serverNow: parsed.data.serverNow,
    hasMore,
    nextCursor: hasMore && lastItem ? { occurredAt: lastItem.occurredAt, id: lastItem.id } : null,
  };
  const etag = `"notification-${createHash('sha256')
    .update(JSON.stringify(page), 'utf8')
    .digest('base64url')}"`;
  return { page, etag };
}

export async function markAdminNotificationsRead(eventIds: string[]) {
  await requireCapability('audit.read');
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

export async function retryAdminNotificationDelivery(eventId: string) {
  await requireCapability('audit.read');
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
