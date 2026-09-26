import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ALLOWED_CREDENTIAL_LITERALS,
  scanForCredentials,
  TEXTUAL_EXTENSIONS,
} from '../../scripts/release/credential-scan.mjs';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

/**
 * Fixtures are assembled at runtime. A planted credential written out verbatim
 * would be found by the very gate this file tests, so the test would fail the
 * repository it guards.
 */
const compose = (...parts) => parts.join('');

test('repository security gate recognizes GitHub, Telegram, Supabase, and private-key credentials', async () => {
  const source = await read('scripts/release/credential-scan.mjs');
  assert.match(source, /gh\[pousr\]_/u);
  assert.match(source, /github_pat_/u);
  assert.match(source, /sb_secret_/u);
  assert.match(source, /\[0-9\]\{6,12\}:\[A-Za-z0-9_-\]\{30,/u);
  assert.ok(source.includes('PRIVATE KEY-----'));
});

test('the gate reads the file types documentation and operator tooling use', () => {
  // Markdown, TOML, Python, PowerShell and shell files were never scanned, so a
  // credential pasted into a runbook or into supabase/config.toml passed freely.
  for (const extension of ['.md', '.toml', '.py', '.ps1', '.sh']) {
    assert.ok(TEXTUAL_EXTENSIONS.has(extension), `${extension} is not scanned`);
  }
  // The extensions the gate already covered must not be lost.
  for (const extension of ['.ts', '.tsx', '.mjs', '.json', '.sql', '.yml']) {
    assert.ok(TEXTUAL_EXTENSIONS.has(extension), `${extension} stopped being scanned`);
  }
});

test('a production credential in a document or config file is refused', () => {
  const connectionString = compose(
    'postgresql://postgres:',
    'Sup3rSecretPass',
    '@db.example-ref.supabase.co:5432/postgres',
  );
  assert.deepEqual(scanForCredentials(connectionString), [
    'database connection string (host db.example-ref.supabase.co)',
  ]);

  const turnstileSecret = compose('0x4AAAAAAA', 'BcDeFgHiJkLmNoPqRsTuVwXyZ012');
  assert.deepEqual(scanForCredentials(turnstileSecret), ['credential-like value']);

  const webhookSecret = compose('v1,whsec_', 'dGhpcy1pcy1hLXRlc3Qtd2ViaG9vay1zZWNyZXQ=');
  assert.deepEqual(scanForCredentials(webhookSecret), ['credential-like value']);
});

test('disposable local stacks and documented defaults stay green', () => {
  // Flagging the local Supabase stack, the Docker gateway or the documented
  // default password would train operators to ignore the gate.
  for (const host of ['127.0.0.1', 'localhost', 'host.docker.internal', '172.17.0.1']) {
    assert.deepEqual(
      scanForCredentials(compose('postgresql://postgres:postgres@', host, ':54322/postgres')),
      [],
      host,
    );
  }
  assert.deepEqual(
    scanForCredentials('postgresql://postgres:postgres@db.example-ref.supabase.co:5432/postgres'),
    [],
  );
  for (const literal of ALLOWED_CREDENTIAL_LITERALS) {
    assert.deepEqual(scanForCredentials(literal), [], literal);
  }
});

test('the gate never echoes the value it found', () => {
  const secret = compose('Sup3rSecretPass', 'word');
  const reasons = scanForCredentials(
    compose('postgresql://postgres:', secret, '@db.example-ref.supabase.co:5432/postgres'),
  );
  assert.equal(reasons.length, 1);
  assert.ok(!reasons[0].includes(secret), 'the reason must not repeat the credential');
});
