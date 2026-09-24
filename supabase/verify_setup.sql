-- PipelineSync AI — "is my Supabase project ready?" (READ-ONLY, safe to run any time)
-- Supabase Dashboard → SQL Editor → New query → paste this whole file → Run.
--
-- Every row should say OK. Anything else: run supabase/pipelinesync_ai_schema.sql
-- (it is idempotent, so re-running it is safe), then run this file again.
--
-- What this checks, and where it comes from:
--   lib/supabase-leads.js writes only these 4 tables and only these 46 columns
--   (pipeline_leads 18, pipeline_lead_sessions 12, pipeline_blueprints 10, pipeline_lead_events 6)

with counts as (
  select
    (select count(*) from (values ('public.pipeline_leads'),('public.pipeline_lead_sessions'),
                                  ('public.pipeline_blueprints'),('public.pipeline_lead_events')) v(t)
      where to_regclass(v.t) is not null) as tables_found,
    (select count(*) from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and a.attnum > 0 and not a.attisdropped
        and c.relname in ('pipeline_leads','pipeline_lead_sessions','pipeline_blueprints','pipeline_lead_events')) as columns_found,
    (select count(*) from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in ('pipeline_leads','pipeline_lead_sessions','pipeline_blueprints','pipeline_lead_events')
        and c.relrowsecurity) as rls_found,
    (select count(distinct g.table_name) from information_schema.role_table_grants g
      where g.table_schema = 'public' and g.grantee = 'service_role'
        and g.table_name in ('pipeline_leads','pipeline_lead_sessions','pipeline_blueprints','pipeline_lead_events')) as grants_found,
    (select count(*) from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'set_updated_at') as fn_found,
    (select count(*) from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and not t.tgisinternal
        and t.tgname like 'trg\_%\_updated_at') as trg_found,
    (select case when to_regclass('auth.users') is null then 0 else 1 end) as auth_found
)
select check_name, result, action
from (
  select 1 as ord, 'the 4 tables exist' as check_name,
         counts.tables_found::text || ' of 4' as result,
         case when counts.tables_found = 4 then 'OK' else 'ACTION: run supabase/pipelinesync_ai_schema.sql' end as action
    from counts
  union all
  select 2, 'the 46 columns the app reads and writes exist',
         counts.columns_found::text || ' of 46 required',
         case when counts.columns_found >= 46 then 'OK' else 'ACTION: run supabase/pipelinesync_ai_schema.sql' end
    from counts
  union all
  select 3, 'row level security is on',
         counts.rls_found::text || ' of 4 tables',
         case when counts.rls_found = 4 then 'OK' else 'ACTION: run supabase/pipelinesync_ai_schema.sql' end
    from counts
  union all
  select 4, 'service_role can read and write (the key the server uses)',
         counts.grants_found::text || ' of 4 tables',
         case when counts.grants_found = 4 then 'OK' else 'ACTION: run supabase/pipelinesync_ai_schema.sql, section 5' end
    from counts
  union all
  select 5, 'updated_at trigger function exists',
         counts.fn_found::text || ' of 1',
         case when counts.fn_found = 1 then 'OK' else 'ACTION: run supabase/pipelinesync_ai_schema.sql, section 1' end
    from counts
  union all
  select 6, 'updated_at triggers exist (leads, sessions, blueprints)',
         counts.trg_found::text || ' of 3',
         case when counts.trg_found = 3 then 'OK' else 'ACTION: run supabase/pipelinesync_ai_schema.sql, sections 1 to 3' end
    from counts
  union all
  select 7, 'auth.users exists (leads reference the workspace owner)',
         counts.auth_found::text || ' of 1',
         case when counts.auth_found = 1 then 'OK' else 'ACTION: this is not a Supabase project, or auth schema is missing' end
    from counts
) checks
order by ord;

-- ============================================================
-- The three values the app needs in its environment
-- ============================================================
-- 1) and 2) Project URL and secret key: Dashboard → Project Settings → API
-- 3) The workspace owner UUID (leads are stored under this user):
select id as pipelinesync_workspace_owner_id, email, created_at
from auth.users
order by created_at asc
limit 5;

-- ============================================================
-- What should be in the environment (server only, never the browser)
-- ============================================================
-- SUPABASE_URL=https://<project-ref>.supabase.co
-- SUPABASE_SECRET_KEY=<secret key>            (legacy projects: SUPABASE_SERVICE_ROLE_KEY)
-- PIPELINESYNC_WORKSPACE_OWNER_ID=<uuid from the query above>
--
-- Leave all three empty and the app still runs: leads go to the function log and /dev/outbox
-- instead of Supabase.

-- ============================================================
-- Optional: prove the write path the app uses, then undo it (nothing is left behind)
-- ============================================================
-- Replace the UUID with your owner id, then run:
--
-- begin;
--   insert into public.pipeline_leads (user_id, name, email, email_normalized, source)
--   values ('00000000-0000-0000-0000-000000000000', 'Schema check', 'schema-check@example.com',
--           'schema-check@example.com', 'pipelinesync_ai')
--   returning id, status, created_at;
-- rollback;
