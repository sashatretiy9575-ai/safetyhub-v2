-- The electrical journal counted only the thousand numbers after its start:
-- once they were used every issuance of the course was refused, and each sheet
-- tested all thousand candidates against every certificate. It also looked for
-- the course under the slug printed on the certificate, so a renamed course
-- handed its old numbers out again. The next sheet now takes the number after
-- the highest one the course has printed, never below the journal start.

create or replace function private.capture_document_snapshot() returns trigger
language plpgsql security definer set search_path='' as $$
declare s jsonb; p public.document_profiles; d date;
 c_max_participants constant integer := 50;
 v_org text := lower(btrim(new.organization)); v_course text; v_audience text;
 v_base text; v_number text; v_previous public.certificates; v_family text; v_part integer;
 v_chosen_date text := nullif(current_setting('safetyhub.document_date', true), '');
 v_chosen_number text := nullif(btrim(current_setting('safetyhub.protocol_number', true)), '');
begin
 if tg_op='UPDATE' then
   if new.document_snapshot is distinct from old.document_snapshot then raise exception 'DOCUMENT_SNAPSHOT_IMMUTABLE'; end if;
   return new;
 end if;
 select private.certificate_settings_payload(false) into s;
 v_course := private.certificate_course_slug(new.revision_id, new.test_slug);
 -- One category: everybody is on it. «ИТР» and «рабочие»: the administrator's
 -- choice for the person, otherwise what the position says.
 select * into p from public.document_profiles where course_slug=v_course and audience='all';
 if p.id is null then
   v_audience := coalesce(
     (select document_audience from public.profiles where id=new.user_id),
     private.document_audience_for_position(new.job));
   select * into p from public.document_profiles where course_slug=v_course and audience=v_audience;
 end if;
 if exists(select 1 from public.document_profiles where course_slug=v_course) and p.id is null then
   raise exception using errcode='22023', message='DOCUMENT_PROFILE_REQUIRED';
 end if;
 if new.supersedes_certificate_id is not null then
   select * into v_previous from public.certificates where id=new.supersedes_certificate_id;
 end if;
 -- The date the administrator chose when issuing; a corrected name or company
 -- stays on the sitting of the document it replaces; otherwise the day of issue.
 d:=coalesce(
   v_chosen_date::date,
   case when new.issue_source='identity_correction' then (v_previous.document_snapshot->>'protocolDate')::date end,
   (new.issued_at at time zone 'Asia/Oral')::date);
 v_base:=coalesce(v_chosen_number,to_char(d,'DD.MM'));
 v_family:=coalesce(p.body->>'family','general');
 -- An electrical course keeps a journal: the number the centre's journal is at
 -- is stated once on the course, and every sheet takes the next free one.
 if v_family='electrical' and v_chosen_number is null
   and coalesce(p.body->'electrical'->>'journalStart','') ~ '^[1-9][0-9]{0,8}$' then
   v_base:=p.body->'electrical'->>'journalStart';
 end if;
 if v_family='electrical' then
   -- The journal of the course is one for every company, so the lock is too.
   perform pg_advisory_xact_lock(hashtextextended('protocol:electrical|'||v_course,0));
   -- A corrected document keeps the sheet it replaces; so does a person reissued
   -- on the same day.
   if v_chosen_number is null then
     if new.issue_source='identity_correction' and v_previous.id is not null then
       v_number:=v_previous.document_snapshot->>'protocolNumber';
     else
       select c.document_snapshot->>'protocolNumber' into v_number
       from public.certificates c
       where (c.id=new.supersedes_certificate_id or (c.user_id=new.user_id and c.revoked_at is null))
         and c.test_slug=new.test_slug and c.document_snapshot->>'protocolDate'=d::text
         and c.document_snapshot#>>'{profile,id}' is not distinct from p.id
       order by (c.id=new.supersedes_certificate_id) desc, c.issued_at desc limit 1;
     end if;
   end if;
   if v_number is null then
     if v_base ~ '^[0-9]{1,9}$' then
       -- «128» runs on as the journal does: the next number after the highest
       -- this course has printed, and never below the one the journal starts
       -- from. The course is matched by its current slug, so a renamed course
       -- keeps counting from its old sheets.
       select greatest(v_base::bigint,
                       coalesce(max((c.document_snapshot->>'protocolNumber')::bigint) + 1, 0))::text
       into v_number
       from public.certificates c
       where private.certificate_course_slug(c.revision_id, c.test_slug) = v_course
         and c.document_snapshot->>'protocolNumber' ~ '^[0-9]{1,9}$';
     else
       select coalesce(max(private.protocol_part(c.document_snapshot->>'protocolNumber',v_base)),0)+1
       into v_part
       from public.certificates c
       where c.test_slug=new.test_slug and c.document_snapshot->>'protocolDate'=d::text
         and private.protocol_part(c.document_snapshot->>'protocolNumber',v_base) is not null;
       v_number:=case when v_part<=1 then v_base else v_base||'-'||v_part::text end;
     end if;
   end if;
 else
 -- One sitting at a time: two issuances for the same protocol must not both
 -- count forty-nine and both take the fiftieth place.
 perform pg_advisory_xact_lock(hashtextextended('protocol:'||v_org||'|'||new.test_slug||'|'||d::text,0));
 -- A corrected document of the same company and category keeps its number.
 if new.issue_source='identity_correction' and v_chosen_number is null
   and v_previous.id is not null and lower(btrim(v_previous.organization))=v_org
   and v_previous.document_snapshot->>'protocolDate'=d::text
   and v_previous.document_snapshot#>>'{profile,id}' is not distinct from p.id then
   v_number:=v_previous.document_snapshot->>'protocolNumber';
 end if;
 -- A reissue on the same day stays on the protocol the person is already on.
 if v_number is null then
   select c.document_snapshot->>'protocolNumber' into v_number
   from public.certificates c
   where (c.id=new.supersedes_certificate_id or (c.user_id=new.user_id and c.revoked_at is null))
     and c.test_slug=new.test_slug and lower(btrim(c.organization))=v_org
     and c.document_snapshot->>'protocolDate'=d::text
     and c.document_snapshot#>>'{profile,id}' is not distinct from p.id
     and private.protocol_part(c.document_snapshot->>'protocolNumber',v_base) is not null
   order by (c.id=new.supersedes_certificate_id) desc, c.issued_at desc limit 1;
 end if;
 if v_number is null then
   -- «ИТР» and «рабочий состав» sit on protocols of their own, as the centre
   -- prints them: a protocol takes one listener category and at most fifty
   -- people. The person joins the last protocol of their category that still
   -- has room; otherwise the day's next number opens.
   with protocols as (
     select c.document_snapshot->>'protocolNumber' as num,
            c.document_snapshot#>>'{profile,id}' as profile_id,
            count(distinct c.user_id) filter (where c.revoked_at is null) as people,
            private.protocol_part(c.document_snapshot->>'protocolNumber',v_base) as part
     from public.certificates c
     where c.test_slug=new.test_slug and lower(btrim(c.organization))=v_org
       and c.document_snapshot->>'protocolDate'=d::text
       and private.protocol_part(c.document_snapshot->>'protocolNumber',v_base) is not null
     group by 1,2
   )
   select coalesce(
     (select num from protocols
      where profile_id is not distinct from p.id and people<c_max_participants
      order by part desc limit 1),
     case when not exists(select 1 from protocols) then v_base
          else v_base||'-'||((select max(part) from protocols)+1)::text end)
   into v_number;
 end if;
 end if;
 new.document_snapshot:=jsonb_build_object(
   'schemaVersion',1,'captureKind','issuance','capturedAt',statement_timestamp(),
   'settings',s,
   'profile',private.complete_document_profile(
     case when p.id is null then null
       else p.body||jsonb_build_object('id',p.id,'courseSlug',p.course_slug,'audience',p.audience) end,
     (select document_commission from public.certificate_settings where singleton)),
   'profileVersion',p.version,
   'protocolNumber',v_number,'protocolDate',d,
   'education',coalesce((select education from public.profiles where id=new.user_id),''),
   'photo', (select jsonb_build_object('objectKey',object_key,'legacyImported',legacy_imported) from private.profile_avatar_manifests where user_id=new.user_id)
 );
 return new;
end; $$;
