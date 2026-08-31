import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const routeUrl = new URL('../../app/api/profile/avatar/route.ts', import.meta.url);
const migrationUrl = new URL(
  '../../supabase/migrations/20260813070000_persistent_actor_quota.sql',
  import.meta.url,
);

async function routeSource() {
  return readFile(routeUrl, 'utf8');
}

async function migrationSource() {
  return readFile(migrationUrl, 'utf8');
}

test('avatar upload is stage-first and uses only its immutable operation object', async () => {
  const source = await routeSource();

  assert.match(source, /createHash\('sha256'\)\.update\(bytes\)\.digest\('hex'\)/u);
  assert.match(
    source,
    /rpc\(admin, 'begin_profile_avatar_upload', \{[\s\S]*p_expected_sha256: expectedSha256,[\s\S]*p_expected_bytes: bytes\.byteLength/u,
  );
  assert.match(source, /if \(begin\.status !== 'prepared'\) \{[\s\S]*status: 409/u);
  assert.match(
    source,
    /const session = await createClient\(\);[\s\S]*session\.storage[\s\S]*\.upload\(begin\.objectKey, bytes, \{[\s\S]*upsert: false/u,
  );
  assert.doesNotMatch(source, /admin\.storage[\s\S]{0,120}\.upload\(/u);
  assert.match(source, /uploadResult\?\.path !== begin\.objectKey/u);
  assert.doesNotMatch(source, /\$\{context\.user\.id\}\/avatar\.webp/u);
  assert.doesNotMatch(source, /upsert: true/u);
  assert.doesNotMatch(source, /mark_profile_avatar_uploaded/u);
});

test('avatar bytes are durably staged before finalize and RPC fields match the contract', async () => {
  const source = await routeSource();
  const uploadAt = source.indexOf('.upload(begin.objectKey, bytes');
  const writeFinishedAt = source.indexOf('await markUploadLeaseFinished(');
  const markAt = source.indexOf("rpc(admin, 'mark_profile_avatar_staged'");
  const finalizeAt = source.indexOf('const committed = await finalizeWithRecovery');

  assert.ok(
    uploadAt >= 0 && writeFinishedAt > uploadAt && markAt > writeFinishedAt && finalizeAt > markAt,
  );
  assert.match(
    source,
    /'finish_profile_avatar_storage_write', \{[\s\S]*p_user_id: userId,[\s\S]*p_operation_token: operationToken,[\s\S]*p_error_code: errorCode/u,
  );
  assert.match(
    source,
    /await markUploadLeaseFinished\(admin, context\.user\.id, begin\.operationToken, null\)/u,
  );
  assert.match(
    source,
    /'mark_profile_avatar_staged', \{[\s\S]*p_user_id: context\.user\.id,[\s\S]*p_operation_token: begin\.operationToken,[\s\S]*p_observed_sha256: expectedSha256,[\s\S]*p_observed_bytes: bytes\.byteLength/u,
  );
  assert.match(
    source,
    /'finalize_profile_avatar_upload', \{[\s\S]*p_user_id: userId,[\s\S]*p_operation_token: operationToken/u,
  );
  assert.doesNotMatch(source, /p_uploaded_at/u);
});

test('duplicate and ambiguous Storage writes are reconciled by exact content', async () => {
  const source = await routeSource();
  const uploadFlow = source.slice(
    source.indexOf('const { data: uploadResult, error: uploadError }'),
    source.indexOf("rpc(admin, 'mark_profile_avatar_staged'"),
  );

  assert.match(
    source,
    /function mustInspectUploadError[\s\S]*isDefiniteDuplicate\(error\)[\s\S]*mustInspectUploadError\(uploadError\)/u,
  );
  assert.match(source, /\.download\(objectKey, \{\}, \{ cache: 'no-store' \}\)/u);
  assert.match(source, /data\.size !== expectedBytes/u);
  assert.match(source, /observedSha256 === expectedSha256/u);
  assert.match(source, /status === 409/u);
  assert.match(
    uploadFlow,
    /const positivelyVerified = await objectMatches\([\s\S]*if \(!positivelyVerified\) \{\s*throw uploadError;\s*\}[\s\S]*markUploadLeaseFinished/u,
  );
  assert.match(
    uploadFlow,
    /else if \(uploadResult\?\.path !== begin\.objectKey\)[\s\S]*AVATAR_STORAGE_SUCCESS_CONTRACT_BROKEN[\s\S]*markUploadLeaseFinished/u,
  );
});

test('lost finalize response is inspected and retried once', async () => {
  const source = await routeSource();
  const recovery = source.slice(
    source.indexOf('async function finalizeWithRecovery'),
    source.indexOf('async function abortPrecommitOperation'),
  );

  assert.match(recovery, /try \{[\s\S]*parseCommitted\(await finalize\(\)/u);
  assert.match(recovery, /await getOperation\(admin, userId, operationToken\)/u);
  assert.match(recovery, /operation\.status === 'committed'/u);
  assert.match(recovery, /return parseCommitted\(await finalize\(\)/u);
  assert.match(
    source,
    /'get_profile_avatar_upload_operation', \{[\s\S]*p_user_id: userId,[\s\S]*p_operation_token: operationToken/u,
  );
});

test('precommit failure only requests durable cancellation; worker owns removal', async () => {
  const source = await routeSource();
  const compensation = source.slice(
    source.indexOf('async function abortPrecommitOperation'),
    source.indexOf('export async function POST'),
  );

  assert.match(
    compensation,
    /abortResult\.status !== 'cancel_requested' \|\| abortResult\.objectKey !== objectKey/u,
  );
  assert.match(
    compensation,
    /'abort_profile_avatar_upload', \{[\s\S]*p_user_id: userId,[\s\S]*p_operation_token: operationToken,[\s\S]*p_error_code: errorCode/u,
  );
  assert.doesNotMatch(compensation, /\.remove\(/u);
  assert.match(source, /if \(cleanup\) \{[\s\S]*await abortPrecommitOperation\(/u);
  assert.match(source, /\['cancel_requested', 'committed', 'not_found'\]/u);
  assert.doesNotMatch(compensation, /avatar\.webp/u);
  assert.doesNotMatch(compensation, /committed\.objectKey[\s\S]*remove/u);
});

test('signed URL is issued only for the committed object returned by finalize', async () => {
  const source = await routeSource();
  const committedAt = source.indexOf('const committed = await finalizeWithRecovery');
  const signedAt = source.indexOf('.createSignedUrl(committed.objectKey, 10 * 60)');

  assert.ok(committedAt >= 0 && signedAt > committedAt);
  assert.doesNotMatch(source, /createSignedUrl\(begin\.objectKey/u);
  assert.match(source, /if \(signedError \|\| !signed\?\.signedUrl\)/u);
  assert.match(source, /avatarUpdatedAt: committed\.avatarUpdatedAt/u);
});

test('database publication atomically switches an immutable manifest after staging proof', async () => {
  const migration = await migrationSource();
  const finalize = migration.slice(
    migration.indexOf('create function public.finalize_profile_avatar_upload'),
    migration.indexOf('create function public.abort_profile_avatar_upload'),
  );

  assert.match(migration, /create table private\.profile_avatar_manifests/u);
  assert.match(
    migration,
    /object_key = user_id::text \|\| '\/objects\/' \|\| operation_token::text \|\| '\.webp'/u,
  );
  assert.match(migration, /create table private\.avatar_upload_operations/u);
  assert.match(
    migration,
    /v_expires_at timestamptz := statement_timestamp\(\) \+ interval '10 minutes'[\s\S]*storage_write_lease_expires_at[\s\S]*statement_timestamp\(\) \+ interval '30 minutes'/u,
  );
  assert.match(
    migration,
    /create unique index avatar_upload_one_live_per_user_idx[\s\S]*where state in \([\s\S]*'prepared'[\s\S]*'cancel_requested'/u,
  );
  assert.match(finalize, /if v_operation\.state <> 'staged'/u);
  assert.match(finalize, /v_operation\.expected_sha256/u);
  assert.match(finalize, /v_operation\.expected_bytes/u);

  const manifestAt = finalize.indexOf('insert into private.profile_avatar_manifests');
  const profileAt = finalize.indexOf('update public.profiles');
  const committedAt = finalize.indexOf("set state = 'committed'");
  assert.ok(manifestAt >= 0 && profileAt > manifestAt && committedAt > profileAt);
});

test('only a committed manifest is browser-readable and mutation RPCs remain service-only', async () => {
  const migration = await migrationSource();

  assert.match(
    migration,
    /create policy profile_avatars_select_own on storage\.objects[\s\S]*public\.profile_avatar_object_is_committed\(name\)/u,
  );
  assert.match(
    migration,
    /from private\.profile_avatar_manifests manifest[\s\S]*manifest\.object_key = p_object_name[\s\S]*control\.status = 'active'[\s\S]*not control\.deletion_pending/u,
  );
  assert.match(
    migration,
    /grant execute on function public\.get_my_profile_avatar_manifest\(\)\s+to authenticated/u,
  );
  assert.match(
    migration,
    /create function public\.profile_avatar_storage_write_is_authorized\(p_object_name text\)[\s\S]*volatile[\s\S]*security definer[\s\S]*for share[\s\S]*state = 'prepared'[\s\S]*started_at \+ interval '2 minutes' > clock_timestamp\(\)[\s\S]*storage_write_lease_expires_at > clock_timestamp\(\)/u,
  );
  assert.match(
    migration,
    /revoke execute on function public\.profile_avatar_storage_write_is_authorized\(text\)[\s\S]*from public, anon, authenticated, service_role;\s*grant execute on function public\.profile_avatar_storage_write_is_authorized\(text\)\s+to authenticated/u,
  );
  assert.match(
    migration,
    /create policy profile_avatars_insert_live_operation on storage\.objects\s*for insert to authenticated with check \(\s*bucket_id = 'profile-avatars'\s*and public\.profile_avatar_storage_write_is_authorized\(name\)\s*\)/u,
  );
  assert.match(
    migration,
    /create function private\.guard_profile_avatar_storage_write\(\)[\s\S]*AVATAR_STORAGE_WRITE_NOT_AUTHORIZED[\s\S]*create trigger profile_avatar_storage_write_guard[\s\S]*before insert or update on storage\.objects/u,
  );
  assert.match(
    migration,
    /guard_profile_avatar_storage_write[\s\S]*from public\.account_controls[\s\S]*for share[\s\S]*from private\.avatar_upload_operations[\s\S]*for share[\s\S]*state = 'prepared'[\s\S]*started_at \+ interval '2 minutes' > clock_timestamp\(\)/u,
  );
  assert.match(
    migration,
    /revoke all on function private\.guard_profile_avatar_storage_write\(\)\s+from public, anon, authenticated, service_role/u,
  );
  assert.doesNotMatch(
    migration,
    /create policy profile_avatars_[^\n]+ on storage\.objects\s*for (?:update|delete)/u,
  );
  assert.match(
    migration,
    /revoke execute on function public\.get_profile_avatar_manifest\(uuid\)\s+from public, anon, authenticated, service_role;\s*grant execute on function public\.get_profile_avatar_manifest\(uuid\)\s+to service_role/u,
  );

  for (const signature of [
    'begin_profile_avatar_upload\\(uuid,text,integer\\)',
    'finish_profile_avatar_storage_write\\(uuid,uuid,text\\)',
    'mark_profile_avatar_staged\\(uuid,uuid,text,integer\\)',
    'finalize_profile_avatar_upload\\(uuid,uuid\\)',
    'abort_profile_avatar_upload\\(uuid,uuid,text\\)',
  ]) {
    assert.match(
      migration,
      new RegExp(
        `revoke execute on function public\\.${signature}\\s+from public, anon, authenticated, service_role;[\\s\\S]*grant execute on function public\\.${signature}\\s+to service_role`,
        'u',
      ),
    );
  }
});

test('avatar reconciliation leases expired and cleanup-pending operations durably', async () => {
  const migration = await migrationSource();
  const claim = migration.slice(
    migration.indexOf('create function public.claim_profile_avatar_reconciliation'),
    migration.indexOf('create function public.complete_profile_avatar_reconciliation'),
  );
  const complete = migration.slice(
    migration.indexOf('create function public.complete_profile_avatar_reconciliation'),
    migration.indexOf('create function public.prune_terminal_avatar_upload_operations'),
  );

  assert.match(claim, /for update skip locked/u);
  assert.match(
    claim,
    /operation\.state in \('prepared', 'staged'\)[\s\S]*operation\.expires_at <= statement_timestamp\(\)/u,
  );
  assert.match(claim, /lease_expires_at = statement_timestamp\(\) \+ interval '5 minutes'/u);
  assert.match(complete, /v_operation\.lease_owner is distinct from p_worker_id/u);
  assert.match(complete, /message = 'AVATAR_RECONCILE_LEASE_INVALID'/u);
  assert.match(complete, /p_outcome = 'cleaned'/u);
  assert.match(complete, /p_outcome = 'retry'/u);
  assert.match(complete, /state = 'aborted'/u);
  assert.match(complete, /artifacts_cleared_at = statement_timestamp\(\)/u);
});
