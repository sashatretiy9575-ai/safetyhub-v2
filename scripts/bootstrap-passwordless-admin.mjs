import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) {
    throw new Error(`Missing ${name}.`);
  }
  return process.argv[index + 1];
}

function normalizedEmail(value) {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email)) {
    throw new Error('BOOTSTRAP_ADMIN_EMAIL_INVALID');
  }
  return email;
}

function requireConfiguredEnvironment() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secret) {
    throw new Error('BOOTSTRAP_ADMIN_ENV_MISSING');
  }
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' &&
    parsed.hostname !== 'localhost' &&
    parsed.hostname !== '127.0.0.1'
  ) {
    throw new Error('BOOTSTRAP_ADMIN_URL_INVALID');
  }
  return { url, secret, hostname: parsed.hostname };
}

async function findExactlyOneUser(client, email) {
  const matches = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 1_000 });
    if (error) throw new Error('BOOTSTRAP_ADMIN_USER_LOOKUP_FAILED');
    for (const user of data.users) {
      if (typeof user.email === 'string' && user.email.trim().toLowerCase() === email)
        matches.push(user);
    }
    if (data.users.length < 1_000) break;
  }
  if (matches.length !== 1) throw new Error('BOOTSTRAP_ADMIN_USER_NOT_UNIQUE');
  const [user] = matches;
  if (!user.email_confirmed_at) throw new Error('BOOTSTRAP_ADMIN_EMAIL_UNCONFIRMED');
  return user;
}

async function main() {
  const email = normalizedEmail(option('--email'));
  const confirmationEmail = normalizedEmail(option('--confirm-email'));
  if (email !== confirmationEmail) throw new Error('BOOTSTRAP_ADMIN_CONFIRMATION_MISMATCH');

  const { url, secret, hostname } = requireConfiguredEnvironment();
  if (!['localhost', '127.0.0.1'].includes(hostname) && !process.argv.includes('--allow-remote')) {
    throw new Error('BOOTSTRAP_ADMIN_REMOTE_CONFIRMATION_REQUIRED');
  }

  const client = createClient(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const user = await findExactlyOneUser(client, email);
  const { data, error } = await client.rpc('restore_admin_access', { p_user_id: user.id });
  if (error || data !== user.id) throw new Error('BOOTSTRAP_ADMIN_ROLE_GRANT_FAILED');

  // Do not echo the email or service configuration into terminal history/logs.
  console.log(JSON.stringify({ result: 'ADMIN_BOOTSTRAPPED', userId: user.id }));
}

await main();
