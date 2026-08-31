import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

const isLocal = process.argv.includes('--local');
const isLinked = process.argv.includes('--linked');
const checkOnly = process.argv.includes('--check');
if (isLocal === isLinked) {
  console.error('Choose exactly one target: --local or --linked.');
  process.exit(1);
}

const EXPECTED_BUCKETS = [
  {
    id: 'course-presentations-staging',
    public: false,
    fileSizeLimit: 25 * 1024 * 1024,
    allowedMimeTypes: ['application/pdf', 'image/webp'],
  },
  {
    id: 'course-presentations',
    public: true,
    fileSizeLimit: 25 * 1024 * 1024,
    allowedMimeTypes: ['application/pdf', 'image/webp'],
  },
];

function decodeShellValue(rawValue) {
  const value = rawValue.trim().replace(/[;]$/u, '');
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function localEnvironment() {
  const cli = path.resolve('node_modules/supabase/dist/supabase.js');
  const result = spawnSync(process.execPath, [cli, 'status', '-o', 'env'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 2 * 60 * 1000,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Local Supabase is not running.');
  }
  const values = {};
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = line.match(/^(API_URL|SERVICE_ROLE_KEY)=(.+)$/u);
    if (match) values[match[1]] = decodeShellValue(match[2]);
  }
  if (!values.API_URL || !values.SERVICE_ROLE_KEY) {
    throw new Error('Local Supabase status did not include API credentials.');
  }
  return { url: values.API_URL, secret: values.SERVICE_ROLE_KEY };
}

function linkedEnvironment() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) throw new Error('Linked Supabase environment is not configured.');
  const parsed = new URL(url);
  if (!parsed.hostname.endsWith('.supabase.co')) {
    throw new Error('Refusing a non-Supabase linked host.');
  }
  return { url, secret };
}

function normalizedMimeTypes(value) {
  return [...(value ?? [])].map(String).sort();
}

function bucketMatches(actual, expected) {
  return (
    actual.public === expected.public &&
    Number(actual.file_size_limit) === expected.fileSizeLimit &&
    JSON.stringify(normalizedMimeTypes(actual.allowed_mime_types)) ===
      JSON.stringify(normalizedMimeTypes(expected.allowedMimeTypes))
  );
}

const target = isLocal ? localEnvironment() : linkedEnvironment();
const supabase = createClient(target.url, target.secret, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const results = [];
for (const expected of EXPECTED_BUCKETS) {
  const { data: current, error: readError } = await supabase.storage.getBucket(expected.id);
  if (readError && !/not found|does not exist/iu.test(readError.message)) {
    throw new Error(`Could not inspect Storage bucket ${expected.id}.`);
  }

  if (!current) {
    if (checkOnly) {
      results.push({ id: expected.id, status: 'missing' });
      continue;
    }
    const { error } = await supabase.storage.createBucket(expected.id, {
      public: expected.public,
      fileSizeLimit: expected.fileSizeLimit,
      allowedMimeTypes: expected.allowedMimeTypes,
    });
    if (error) throw new Error(`Could not create Storage bucket ${expected.id}.`);
    results.push({ id: expected.id, status: 'created' });
    continue;
  }

  if (bucketMatches(current, expected)) {
    results.push({ id: expected.id, status: 'ready' });
    continue;
  }
  if (checkOnly) {
    results.push({ id: expected.id, status: 'drift' });
    continue;
  }
  const { error } = await supabase.storage.updateBucket(expected.id, {
    public: expected.public,
    fileSizeLimit: expected.fileSizeLimit,
    allowedMimeTypes: expected.allowedMimeTypes,
  });
  if (error) throw new Error(`Could not update Storage bucket ${expected.id}.`);
  results.push({ id: expected.id, status: 'updated' });
}

const invalid = results.filter(({ status }) => status === 'missing' || status === 'drift');
console.log(JSON.stringify({ ok: invalid.length === 0, target: isLocal ? 'local' : 'linked', results }));
if (invalid.length > 0) process.exitCode = 1;
