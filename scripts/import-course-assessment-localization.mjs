import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

const uuid = z.string().uuid();
const option = z.object({ id: uuid, text: z.string().trim().min(1).max(2_000) }).strict();
const question = z
  .object({
    id: uuid,
    text: z.string().trim().min(1).max(2_000),
    options: z.array(option).length(4),
    explanation: z.string().trim().max(4_000).default(''),
  })
  .strict();
const variant = z
  .object({
    id: uuid,
    variantNumber: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    questions: z.array(question).length(10),
  })
  .strict();
const bundleSchema = z
  .object({
    version: z.literal(1),
    courseId: uuid,
    locale: z.enum(['kk', 'en', 'zh']),
    expectedVersion: z.number().int().positive(),
    questionVariants: z.array(variant).length(3),
  })
  .strict()
  .superRefine((bundle, context) => {
    if (new Set(bundle.questionVariants.map((item) => item.variantNumber)).size !== 3) {
      context.addIssue({ code: 'custom', path: ['questionVariants'], message: 'variantNumbers' });
    }
    const ids = bundle.questionVariants.flatMap((item) => [
      item.id,
      ...item.questions.flatMap((entry) => [entry.id, ...entry.options.map((answer) => answer.id)]),
    ]);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', path: ['questionVariants'], message: 'duplicateIds' });
    }
  });

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const apply = process.argv.includes('--apply');
const check = process.argv.includes('--check');
const fileArgument = optionValue('--file');
if (apply === check || !fileArgument) {
  throw new Error(
    'Usage: import-course-assessment-localization.mjs (--check | --apply) --file <bundle.json> [--confirmation IMPORT:<courseId>:<locale>]',
  );
}

const filePath = path.resolve(fileArgument);
const raw = await fs.readFile(filePath, 'utf8');
if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024) throw new Error('IMPORT_BUNDLE_TOO_LARGE');
const bundle = bundleSchema.parse(JSON.parse(raw));

const summary = {
  ok: true,
  mode: check ? 'check' : 'apply',
  courseId: bundle.courseId,
  locale: bundle.locale,
  expectedVersion: bundle.expectedVersion,
  variants: bundle.questionVariants.length,
  questions: bundle.questionVariants.reduce((total, item) => total + item.questions.length, 0),
  options: bundle.questionVariants.reduce(
    (total, item) =>
      total + item.questions.reduce((subtotal, entry) => subtotal + entry.options.length, 0),
    0,
  ),
};

if (check) {
  console.log(JSON.stringify(summary));
  process.exit(0);
}

const confirmation = optionValue('--confirmation');
if (confirmation !== `IMPORT:${bundle.courseId}:${bundle.locale}`) {
  throw new Error('IMPORT_CONFIRMATION_MISMATCH');
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const actorId = process.env.SAFETYHUB_CONTENT_OPERATOR_ID;
if (!url || !secret || !actorId || !uuid.safeParse(actorId).success) {
  throw new Error(
    'Set NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY), and SAFETYHUB_CONTENT_OPERATOR_ID.',
  );
}
const parsedUrl = new URL(url);
if (
  parsedUrl.protocol !== 'https:' &&
  parsedUrl.hostname !== '127.0.0.1' &&
  parsedUrl.hostname !== 'localhost'
) {
  throw new Error('SUPABASE_URL_UNTRUSTED');
}

const supabase = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const { data, error } = await supabase.rpc('import_course_assessment_localization', {
  p_actor_id: actorId,
  p_test_id: bundle.courseId,
  p_locale: bundle.locale,
  p_expected_version: bundle.expectedVersion,
  p_question_variants: bundle.questionVariants,
});
if (error) throw new Error(`ASSESSMENT_LOCALIZATION_IMPORT_FAILED:${error.code ?? 'UNKNOWN'}`);
const result = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
if (
  !result ||
  result.courseId !== bundle.courseId ||
  result.locale !== bundle.locale ||
  result.variantCount !== 3 ||
  result.questionCount !== 30 ||
  typeof result.draftVersion !== 'number' ||
  typeof result.contentHash !== 'string' ||
  !/^[0-9a-f]{64}$/u.test(result.contentHash)
) {
  throw new Error('ASSESSMENT_LOCALIZATION_IMPORT_RECEIPT_INVALID');
}

console.log(
  JSON.stringify({
    ...summary,
    draftVersion: result.draftVersion,
    contentHash: result.contentHash,
  }),
);
