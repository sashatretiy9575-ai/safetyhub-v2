import { z } from 'zod';

export const ADMIN_NOTIFICATION_EVENT_TYPES = [
  'account.approval_requested',
  'course.completed',
  'system.alert',
] as const;

export const ADMIN_NOTIFICATION_DELIVERY_STATES = [
  'pending',
  'leased',
  'retry',
  'delivered',
  'dead',
] as const;

const uuidSchema = z.string().uuid();
const timestampSchema = z.string().datetime({ offset: true });
const adminPathSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^\/admin(?:\/|$)/u);
const singleLineTextSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));

const deliverySchema = z
  .object({
    status: z.enum(ADMIN_NOTIFICATION_DELIVERY_STATES),
    attempts: z.number().int().min(0).max(10),
    lastErrorCategory: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Z0-9_]+$/u)
      .nullable(),
  })
  .strict();

const eventEnvelopeSchema = z.object({
  id: uuidSchema,
  correlationId: uuidSchema,
  occurredAt: timestampSchema,
  readAt: timestampSchema.nullable(),
  delivery: deliverySchema,
});

const approvalRequestedPayloadSchema = z
  .object({
    userId: uuidSchema,
    name: singleLineTextSchema,
    surname: singleLineTextSchema,
    locale: z.enum(['ru', 'kk', 'en', 'zh']),
    requestedAt: timestampSchema,
    adminPath: adminPathSchema,
  })
  .strict();

const courseCompletedPayloadSchema = z
  .object({
    attemptId: uuidSchema,
    userId: uuidSchema,
    name: singleLineTextSchema,
    surname: singleLineTextSchema,
    locale: z.enum(['ru', 'kk', 'en', 'zh']),
    courseTitle: singleLineTextSchema,
    result: z.enum(['passed', 'failed']),
    score: z.number().int().min(0).max(1000),
    total: z.number().int().min(1).max(1000),
    completedAt: timestampSchema,
    adminPath: adminPathSchema,
  })
  .strict()
  .refine((payload) => payload.score <= payload.total);

const systemAlertPayloadSchema = z
  .object({
    machineCode: z
      .string()
      .min(3)
      .max(80)
      .regex(/^[A-Z][A-Z0-9_]+$/u),
    correlationId: uuidSchema,
    adminPath: adminPathSchema,
  })
  .strict();

export const adminNotificationEventSchema = z
  .discriminatedUnion('type', [
    eventEnvelopeSchema.extend({
      type: z.literal('account.approval_requested'),
      payload: approvalRequestedPayloadSchema,
    }),
    eventEnvelopeSchema.extend({
      type: z.literal('course.completed'),
      payload: courseCompletedPayloadSchema,
    }),
    eventEnvelopeSchema.extend({
      type: z.literal('system.alert'),
      payload: systemAlertPayloadSchema,
    }),
  ])
  .refine(
    (event) => event.type !== 'system.alert' || event.correlationId === event.payload.correlationId,
  );

export const adminNotificationRpcPageSchema = z
  .object({
    items: z.array(adminNotificationEventSchema).max(50),
    unread: z.number().int().min(0),
    serverNow: timestampSchema,
  })
  .strict();

export const adminNotificationApiPageSchema = adminNotificationRpcPageSchema
  .extend({
    hasMore: z.boolean(),
    nextCursor: z
      .object({
        occurredAt: timestampSchema,
        id: uuidSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

export type AdminNotificationEvent = z.infer<typeof adminNotificationEventSchema>;
export type AdminNotificationDeliveryState = (typeof ADMIN_NOTIFICATION_DELIVERY_STATES)[number];

export type AdminNotificationPage = z.infer<typeof adminNotificationApiPageSchema>;
