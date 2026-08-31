import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeGeneratedTypes } from '../../scripts/generate-supabase-types.mjs';

const authContext = `      get_auth_context: {
        Args: never
        Returns: {
          capabilities: string[]
          user_id: string
        }
      }`;

test('normalization removes linked PostgREST metadata and canonicalizes table returns', () => {
  const linked = `export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.17"
  }
  public: {
    Functions: {
${authContext.replace('        }\n      }', '        }[]\n      }')}
    }
  }
}
`;

  const normalized = normalizeGeneratedTypes(linked);

  assert.doesNotMatch(normalized, /__InternalSupabase|PostgrestVersion/u);
  assert.match(normalized, /get_auth_context:[\s\S]*Returns: \{[\s\S]*\}\[\]/u);
  assert.equal(normalized.endsWith('\n'), true);
});

test('local and linked generator shapes normalize to identical output', () => {
  const prefix = `export type Database = {
  public: {
    Functions: {
`;
  const suffix = `
    }
  }
}
`;
  const local = `${prefix}${authContext}${suffix}`;
  const linked = `${prefix}${authContext.replace(
    '        }\n      }',
    '        }[]\n      }',
  )}${suffix}`;

  assert.equal(normalizeGeneratedTypes(local), normalizeGeneratedTypes(linked));
});
