import { z } from 'zod';

export const certificateIdSchema = z.string().uuid();

export const revokeCertificateSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export type RevokeCertificateValues = z.infer<typeof revokeCertificateSchema>;
