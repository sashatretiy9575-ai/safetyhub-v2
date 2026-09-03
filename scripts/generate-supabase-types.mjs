import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const INTERNAL_SUPABASE_METADATA =
  /^  \/\/ Allows to automatically instantiate createClient with right options\n  \/\/ instead of createClient<[^\n]+\n  __InternalSupabase: \{\n(?:    [^\n]+\n)*  \}\n/mu;
const GET_AUTH_CONTEXT_RETURN =
  /(      get_auth_context: \{\n        Args: never\n        Returns: \{\n[\s\S]*?\n        \})(?:\[\])?(\n      \})/u;

export function normalizeGeneratedTypes(source) {
  const normalizedLineEndings = source.replaceAll('\r\n', '\n');
  const withoutEnvironmentMetadata = normalizedLineEndings.replace(INTERNAL_SUPABASE_METADATA, '');
  const withCanonicalTableReturn = withoutEnvironmentMetadata.replace(
    GET_AUTH_CONTEXT_RETURN,
    '$1[]$2',
  );

  return `${withCanonicalTableReturn.trimEnd()}\n`;
}

async function main() {
  const useLocal = process.argv.includes('--local');
  const useLinked = process.argv.includes('--linked');
  const check = process.argv.includes('--check');
  if (useLocal === useLinked) {
    console.error('Choose exactly one database source: --local or --linked.');
    process.exit(1);
  }

  const target = path.resolve('lib/supabase/database.generated.ts');
  const cli = path.resolve('node_modules/supabase/dist/supabase.js');
  // `gen types --local` authenticates with a generated start-secret that the
  // generator container does not receive once the project has been linked, so it
  // fails with "password authentication failed for user postgres". The local
  // stack always accepts the documented default credentials, and the generator
  // runs in a container, so it must reach the host by name rather than loopback.
  const localDatabaseUrl =
    process.env.SUPABASE_LOCAL_DB_URL ??
    'postgresql://postgres:postgres@host.docker.internal:54322/postgres';
  const source = useLocal ? ['--db-url', localDatabaseUrl] : ['--linked'];
  const generated = spawnSync(
    process.execPath,
    [cli, 'gen', 'types', 'typescript', ...source, '--schema', 'public', '--schema', 'private'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (generated.error || generated.status !== 0 || !generated.stdout.trim()) {
    console.error('Supabase CLI could not generate database types.');
    process.exit(1);
  }

  const normalized = normalizeGeneratedTypes(generated.stdout);
  if (check) {
    const committed = await readFile(target, 'utf8').catch(() => '');
    if (committed.replaceAll('\r\n', '\n') !== normalized) {
      console.error(
        'Generated database types are stale. Run the matching db:types:generate command and commit the result.',
      );
      process.exit(1);
    }
    console.log(`Generated database types match ${useLocal ? 'local' : 'linked'} schema.`);
  } else {
    await writeFile(target, normalized, 'utf8');
    console.log(
      `Updated ${path.relative(process.cwd(), target)} from ${useLocal ? 'local' : 'linked'} schema.`,
    );
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
