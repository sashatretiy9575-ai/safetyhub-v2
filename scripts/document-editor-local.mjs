// Reproducible local-only build/server/E2E runner. No credentials are logged.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { prepareReleaseE2eAuth } from './e2e-passwordless-session.mjs';

if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Node 24 required');
process.loadEnvFile('.env.local');
const env = { ...process.env };
env.SUPABASE_AUTH_CAPTCHA_SECRET = '1x0000000000000000000000000000000AA';
env.SUPABASE_SEND_EMAIL_HOOK_SECRETS = 'v1,whsec_' + randomBytes(32).toString('base64');
const status = spawnSync(process.execPath, ['node_modules/supabase/dist/supabase.js', 'status', '--output', 'json'], { env, encoding: 'utf8', windowsHide: true });
if (status.status !== 0) throw new Error('LOCAL_SUPABASE_UNAVAILABLE');
const local = JSON.parse(status.stdout);
if (!['localhost', '127.0.0.1'].includes(new URL(local.API_URL).hostname)) throw new Error('LOCAL_ONLY');
Object.assign(env, {
  NEXT_PUBLIC_SUPABASE_URL: local.API_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: local.PUBLISHABLE_KEY || local.ANON_KEY,
  SUPABASE_SECRET_KEY: local.SECRET_KEY || local.SERVICE_ROLE_KEY,
  SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY,
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3100', PLAYWRIGHT_BASE_URL: 'http://localhost:3100',
  PLAYWRIGHT_EXTERNAL_SERVER: '1',
  E2E_ADMIN_EMAIL: 'admin@safetyhub.local', E2E_PARTICIPANT_EMAIL: 'participant@safetyhub.local',
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
  SAFETYHUB_TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
  SAFETYHUB_ADMIN_INBOX_ENABLED: 'false',
  SAFETYHUB_SMTP_HOST: '127.0.0.1', SAFETYHUB_SMTP_PORT: '54325', SAFETYHUB_SMTP_TLS: 'none',
  PATH: path.dirname(process.execPath) + path.delimiter + env.PATH,
});
const mode = process.argv[2] ?? 'dev';
let auth;
let args;
if (mode === 'test') {
  auth = await prepareReleaseE2eAuth({ environment: env });
  env.E2E_ADMIN_STORAGE_STATE = auth.adminStatePath;
  env.E2E_PARTICIPANT_STORAGE_STATE = auth.participantStatePath;
  args = ['node_modules/@playwright/test/cli.js', 'test', 'e2e/document-editor.spec.ts', '--workers=1'];
} else if (mode === 'build') args = ['node_modules/next/dist/bin/next', 'build'];
else if (mode === 'start') args = ['node_modules/next/dist/bin/next', 'start', '--hostname', 'localhost', '--port', '3100'];
else if (mode === 'dev') args = ['node_modules/next/dist/bin/next', 'dev', '--hostname', 'localhost', '--port', '3100'];
else throw new Error('Unknown mode');
const child = spawn(process.execPath, args, { env, stdio: 'inherit', windowsHide: true });
const code = await new Promise(resolve => child.on('exit', resolve));
await auth?.cleanup();
process.exitCode = code ?? 1;
