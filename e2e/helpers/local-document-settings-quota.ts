import type { APIRequestContext } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export async function resetLocalDocumentSettingsQuota(request: APIRequestContext, base: string, consumed: 0 | 10 = 0) {
  const local = (url: string) => ['localhost', '127.0.0.1'].includes(new URL(url).hostname);
  if (!local(base) || !local(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '') || process.env.E2E_ADMIN_EMAIL !== 'admin@safetyhub.local') throw new Error('LOCAL_DOCUMENT_FIXTURE_ONLY');
  const identityResponse = await request.get('/api/identity');
  const identity = await identityResponse.json();
  if (!identityResponse.ok() || !/^[0-9a-f-]{36}$/i.test(identity.userId)) throw new Error('LOCAL_DOCUMENT_FIXTURE_IDENTITY_REQUIRED');
  const project = existsSync('supabase/.temp/project-ref') ? readFileSync('supabase/.temp/project-ref', 'utf8').trim() : readFileSync('supabase/config.toml', 'utf8').match(/^project_id\s*=\s*"([a-z0-9_-]+)"/m)?.[1];
  if (!project || !/^[a-z0-9_-]+$/.test(project)) throw new Error('LOCAL_DOCUMENT_FIXTURE_PROJECT_REQUIRED');
  const sql = `do $$ begin if not exists(select 1 from auth.users where id='${identity.userId}' and email='admin@safetyhub.local') then raise exception 'LOCAL_DOCUMENT_FIXTURE_IDENTITY_MISMATCH'; end if; insert into private.business_rate_limits(actor_id,action,window_started_at,consumed) values('${identity.userId}','site.settings.update',now(),${consumed}) on conflict(actor_id,action) do update set consumed=excluded.consumed,window_started_at=excluded.window_started_at; delete from private.coarse_ip_rate_limits where action='site.settings.update'; end $$;`;
  const docker = process.platform === 'win32' ? 'C:/Program Files/Docker/Docker/resources/bin/docker.exe' : 'docker';
  const result = spawnSync(docker, ['exec', 'supabase_db_' + project, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('LOCAL_DOCUMENT_FIXTURE_QUOTA_RESET_FAILED: ' + (result.error?.message ?? result.stderr));
}
