import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  LocalizedSnapshotError,
  validateLocalizedPublishedSnapshot,
} from './localized-published-snapshot.mjs';

function argumentValue(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error('LOCALIZED_SNAPSHOT_ARGUMENT_INVALID');
  return path.resolve(value);
}

export async function runCli(argv = process.argv.slice(2)) {
  try {
    const allowed = new Set(['--if-present', '--snapshot-root']);
    for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index];
      if (!allowed.has(argument)) throw new Error('LOCALIZED_SNAPSHOT_ARGUMENT_INVALID');
      if (argument === '--snapshot-root') index += 1;
    }
    const required = !argv.includes('--if-present');
    const snapshotRoot = argumentValue(
      argv,
      '--snapshot-root',
      path.resolve('content', 'snapshots', 'localizations'),
    );
    const result = await validateLocalizedPublishedSnapshot({ snapshotRoot, required });
    return { exitCode: 0, output: { ok: true, ...result } };
  } catch (error) {
    return {
      exitCode: 1,
      output: {
        ok: false,
        error:
          error instanceof LocalizedSnapshotError
            ? error.message
            : 'LOCALIZED_SNAPSHOT_VALIDATION_FAILED',
      },
    };
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const result = await runCli();
  console.log(JSON.stringify(result.output));
  process.exitCode = result.exitCode;
}
