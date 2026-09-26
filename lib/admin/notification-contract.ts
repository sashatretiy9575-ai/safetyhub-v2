import { APP_LOCALES } from '@/i18n/config';
import * as z from 'zod/mini';

export const ADMIN_NOTIFICATION_DELIVERY_STATES = [
  'pending',
  'leased',
  'retry',
  'delivered',
  'dead',
] as const;

const uuidSchema = z.uuid();
const timestampSchema = z.iso.datetime({ offset: true });
const localeSchema = z.enum(APP_LOCALES);
const adminPathSchema = z
  .string()
  .check(z.minLength(1), z.maxLength(240), z.regex(/^\/admin(?:\/|$)/u));
const singleLineTextSchema = z.string().check(
  z.minLength(1),
  z.maxLength(240),
  z.refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
);

const deliverySchema = z.strictObject({
  status: z.enum(ADMIN_NOTIFICATION_DELIVERY_STATES),
  attempts: z.int().check(z.minimum(0), z.maximum(10)),
  lastErrorCategory: z.nullable(
    z.string().check(z.minLength(1), z.maxLength(64), z.regex(/^[A-Z0-9_]+$/u)),
  ),
});

const eventEnvelopeSchema = z.object({
  id: uuidSchema,
  correlationId: uuidSchema,
  occurredAt: timestampSchema,
  readAt: z.nullable(timestampSchema),
  delivery: deliverySchema,
});

const approvalRequestedPayloadSchema = z.union([
  z.strictObject({
    schemaVersion: z.literal(2),
    locale: localeSchema,
    requestedAt: timestampSchema,
    adminPath: adminPathSchema,
  }),
  // The same application, naming the courses the newcomer clicked before applying.
  z.strictObject({
    schemaVersion: z.literal(3),
    locale: localeSchema,
    requestedAt: timestampSchema,
    adminPath: adminPathSchema,
    courses: z.array(singleLineTextSchema).check(z.minLength(1), z.maxLength(10)),
  }),
  z.strictObject({
    name: z.literal(''),
    surname: z.literal(''),
    locale: z.literal('zh'),
    requestedAt: timestampSchema,
    adminPath: adminPathSchema,
  }),
  z.strictObject({
    name: singleLineTextSchema,
    surname: singleLineTextSchema,
    locale: localeSchema,
    requestedAt: timestampSchema,
    adminPath: adminPathSchema,
  }),
  z.strictObject({
    name: singleLineTextSchema,
    surname: singleLineTextSchema,
    job: singleLineTextSchema.check(z.maxLength(160)),
    organization: singleLineTextSchema.check(z.maxLength(160)),
    phoneCountryIso2: z.string().check(z.regex(/^[A-Z]{2}$/u)),
    phoneE164: z.string().check(z.regex(/^\+[1-9][0-9]{1,14}$/u)),
  }),
]);

// ZH accounts sign up without a printable name, so `name`/`surname` may both
// be empty strings; an empty pair renders as a locale-only line in the inbox.
const blankableLineSchema = z.union([singleLineTextSchema, z.literal('')]);

const courseCompletedPayloadSchema = z
  .strictObject({
    attemptId: uuidSchema,
    userId: uuidSchema,
    name: blankableLineSchema,
    surname: blankableLineSchema,
    locale: localeSchema,
    courseTitle: singleLineTextSchema,
    result: z.enum(['passed', 'failed']),
    score: z.int().check(z.minimum(0), z.maximum(1000)),
    total: z.int().check(z.minimum(1), z.maximum(1000)),
    completedAt: timestampSchema,
    adminPath: adminPathSchema,
  })
  .check(z.refine((payload) => payload.score <= payload.total));

/** An approved person asks for one more course: the «повторная заявка». */
const courseAccessRequestedPayloadSchema = z.strictObject({
  userId: uuidSchema,
  name: blankableLineSchema,
  surname: blankableLineSchema,
  locale: localeSchema,
  courseTitle: singleLineTextSchema,
  requestedAt: timestampSchema,
  adminPath: adminPathSchema,
});

const systemAlertPayloadSchema = z.strictObject({
  machineCode: z.string().check(z.minLength(3), z.maxLength(80), z.regex(/^[A-Z][A-Z0-9_]+$/u)),
  correlationId: uuidSchema,
  adminPath: adminPathSchema,
});

export const adminNotificationEventSchema = z
  .discriminatedUnion('type', [
    z.extend(eventEnvelopeSchema, {
      type: z.literal('account.approval_requested'),
      payload: approvalRequestedPayloadSchema,
    }),
    z.extend(eventEnvelopeSchema, {
      type: z.literal('course.access_requested'),
      payload: courseAccessRequestedPayloadSchema,
    }),
    z.extend(eventEnvelopeSchema, {
      type: z.literal('course.completed'),
      payload: courseCompletedPayloadSchema,
    }),
    z.extend(eventEnvelopeSchema, {
      type: z.literal('system.alert'),
      payload: systemAlertPayloadSchema,
    }),
  ])
  .check(
    z.refine(
      (event) =>
        event.type !== 'system.alert' || event.correlationId === event.payload.correlationId,
    ),
  );

export const adminNotificationRpcPageSchema = z.strictObject({
  items: z.array(adminNotificationEventSchema).check(z.maxLength(50)),
  unread: z.int().check(z.minimum(0)),
  serverNow: timestampSchema,
});

export const adminNotificationApiPageSchema = z.extend(adminNotificationRpcPageSchema, {
  hasMore: z.boolean(),
  nextCursor: z.nullable(
    z.strictObject({
      occurredAt: timestampSchema,
      id: uuidSchema,
    }),
  ),
});

export type AdminNotificationEvent = z.infer<typeof adminNotificationEventSchema>;
export type AdminNotificationDeliveryState = (typeof ADMIN_NOTIFICATION_DELIVERY_STATES)[number];

export type AdminNotificationPage = z.infer<typeof adminNotificationApiPageSchema>;
