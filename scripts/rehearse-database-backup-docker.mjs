import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.166';
function run(executable, args, input) {
  const r = spawnSync(executable, args, { input, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 128 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`Restore rehearsal command failed: ${path.basename(executable)} ${args[0]} (exit ${r.status}); ${String(r.stderr).split('\n').filter(l=>/ERROR:|FATAL:|chown:|Permission denied|No such file/.test(l)).map(l=>l.replace(/DETAIL:.*/, '')).slice(0,3).join(' ')}`);
  return r.stdout;
}
const quote = s => '"' + s.replaceAll('"','""') + '"';

export async function rehearseDockerRestore(schemaDump, dataDump, sourceCounts = null) {
  const name = `safetyhub-restore-${randomUUID()}`;
  const work = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-docker-rehearsal-'));
  let started = false;
  const exec = (args, input) => run('docker', ['exec', ...(input === undefined ? [] : ['-i']), name, ...args], input);
  try {
    run('docker', ['run','--detach','--name',name,'--network','none','--user','postgres','--tmpfs','/tmp:rw,mode=1777','--entrypoint','/bin/sh',IMAGE,'-c',"initdb -D /tmp/cluster --auth=trust --encoding=UTF8 --no-locale >/tmp/init.log 2>&1 && exec postgres -D /tmp/cluster -c listen_addresses='' -c unix_socket_directories=/tmp"]);
    started = true;
    for (let i=0; i<60; i++) {
      const ready=spawnSync('docker',['exec',name,'pg_isready','-h','/tmp','-U','postgres'],{encoding:'utf8',windowsHide:true});
      if (ready.status===0) break;
      if(i===59) throw new Error('Isolated PostgreSQL did not become ready');
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    for(const [file,dest] of [[schemaDump,'schema.dump'],[dataDump,'data.dump']])exec(['/bin/sh','-c',`umask 077; cat > /tmp/${dest}`],await readFile(file));
    const sql = text => exec(['psql','-h','/tmp','-U','postgres','-d','postgres','-X','-A','-t','-v','ON_ERROR_STOP=1','-c',text]).trim();
    sql(`create schema private; create schema extensions; create extension pgcrypto with schema extensions; create extension pg_trgm with schema extensions; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`);
    sql(['anon','authenticated','service_role','authenticator','supabase_auth_admin','dashboard_user'].map(r=>`create role ${quote(r)} nologin;`).join('\n'));
    const list=exec(['pg_restore','--list','/tmp/schema.dump']).split(/\r?\n/).filter(l=>!l.includes(' SCHEMA - public ')&&!l.includes(' SCHEMA - private ')).join('\n');
    exec(['/bin/sh','-c','umask 077; cat > /tmp/schema.list'],list);
    exec(['pg_restore','-h','/tmp','-U','postgres','--exit-on-error','--no-owner','--no-privileges','--use-list','/tmp/schema.list','--schema','public','--schema','private','--dbname','postgres','/tmp/schema.dump']);
    exec(['pg_restore','-h','/tmp','-U','postgres','--exit-on-error','--no-owner','--no-privileges','--data-only','--disable-triggers','--schema','public','--schema','private','--dbname','postgres','/tmp/data.dump']);
    // Derive independent expected row counts from the immutable COPY payload when
    // recovering a backup whose original live-snapshot receipt was interrupted.
    const dumpSql=exec(['pg_restore','--data-only','--schema','public','--schema','private','--file','-','/tmp/data.dump']);
    const archiveCounts={}; let current=null;
    for(const line of dumpSql.split('\n')){
      const match=line.match(/^COPY "?(public|private)"?\."?([^"\s]+)"? \(/);
      if(match){current=`${match[1]}.${match[2]}`;archiveCounts[current]=0;continue;}
      if(current&&line==='\\.'){current=null;continue;}
      if(current)archiveCounts[current]++;
    }
    const counts={};
    for(const [key,expected] of Object.entries(archiveCounts)){
      const [schema,table]=key.split('.'); const actual=Number(sql(`select count(*) from ${quote(schema)}.${quote(table)}`));
      if(actual!==expected || (sourceCounts && actual!==sourceCounts[key]))throw new Error(`Restore row count mismatch: ${key}`);
      counts[key]={archive:expected,restored:actual,...(sourceCounts?{sourceSnapshot:sourceCounts[key]}:{})};
    }
    if(Object.keys(counts).length===0)throw new Error('No application tables verified');
    if(sourceCounts)for(const key of Object.keys(sourceCounts).filter(k=>/^(public|private)\./.test(k)))if(!(key in counts))throw new Error(`Missing restored table: ${key}`);
    return {status:'passed',method:'isolated Docker PostgreSQL, network none, no published ports, tmpfs data',image:IMAGE,imageId:run('docker',['image','inspect','--format','{{.Id}}',IMAGE]).trim(),postgresVersion:sql('show server_version'),verifiedTables:Object.keys(counts).length,counts,expectedCountSource:sourceCounts?'consistent production snapshot plus archive COPY rows':'verified encrypted archive COPY rows; original live snapshot counts unavailable',extensions:'real pgcrypto and pg_trgm; all application indexes included',scope:'public/private DDL and data; auth/storage archive contents retained, service schemas not rehearsed',verifiedAt:new Date().toISOString()};
  } finally {
    if(started)run('docker',['rm','--force',name]);
    const rel=path.relative(os.tmpdir(),work);if(!rel.startsWith('..')&&!path.isAbsolute(rel))await rm(work,{recursive:true,force:true});
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const arg=n=>process.argv[process.argv.indexOf(n)+1];
  for(const n of ['--backup','--recovery-key-file'])if(!process.argv.includes(n))throw new Error(`Required ${n}`);
  const backup=path.resolve(arg('--backup'));const temp=await mkdtemp(path.join(os.tmpdir(),'safetyhub-decrypted-rehearsal-'));const decrypted=path.join(temp,'plain');
  try{
    run(process.execPath,['scripts/restore-database-backup.mjs','--backup',backup,'--output',decrypted,'--recovery-key-file',path.resolve(arg('--recovery-key-file'))]);
    const result=await rehearseDockerRestore(path.join(decrypted,'schema.dump'),path.join(decrypted,'data.dump'));
    const receipt={kind:'safetyhub-docker-backup-rehearsal-v1',encryptedReceiptSha256:createHash('sha256').update(await readFile(path.join(backup,'receipt.json'))).digest('hex'),portableRecoveryVerification:'passed',restoreRehearsal:result};
    await writeFile(path.join(backup,'docker-restore-verification.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({status:result.status,verifiedTables:result.verifiedTables,receipt:path.join(backup,'docker-restore-verification.json')}));
  }finally{const rel=path.relative(os.tmpdir(),temp);if(!rel.startsWith('..')&&!path.isAbsolute(rel))await rm(temp,{recursive:true,force:true});}
}


