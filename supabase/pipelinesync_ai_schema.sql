-- PipelineSync AI — Supabase schema (ready to paste in SQL Editor)
-- Project: SAME Supabase project as PipelineSync / Time-tracker
-- Run: Supabase Dashboard → SQL Editor → New query → paste entire file → Run
-- After: copy SUPABASE_URL, SUPABASE_SECRET_KEY (or legacy SERVICE_ROLE_KEY), and PIPELINESYNC_WORKSPACE_OWNER_ID

-- 0) Extensions (Supabase usually has pgcrypto; run once)
create extension if not exists "pgcrypto";

-- ============================================================
-- 1) pipeline_leads — one row per person who enters name+email gate
-- ============================================================
create table if not exists public.pipeline_leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade, -- the workspace owner from PIPELINESYNC_WORKSPACE_OWNER_ID
  name text,                          -- cleanName(payload.name)
  email text not null,                -- lowercased
  email_normalized text not null,     -- lowercased, for unique lookup
  source text not null default 'pipelinesync_ai',
  status text not null default 'new'
    check (status in ('new','discovery_started','discovery_completed','blueprint_generated','blueprint_delivered','consultation_requested','contacted','qualified','won','lost')),
  industry text,                      -- e.g. solar/medical/home_services/ecommerce/generic
  company text,                       -- business_description (first 90 chars in blueprint meta)
  discovery_started_at timestamptz,
  discovery_completed_at timestamptz,
  blueprint_generated_at timestamptz,
  blueprint_delivered_at timestamptz,
  consultation_requested_at timestamptz,
  consent_given boolean not null default false,
  consent_given_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- unique visitor per workspace (case-insensitive email)
create unique index if not exists pipeline_leads_user_email_unique
  on public.pipeline_leads (user_id, email_normalized);
create index if not exists pipeline_leads_user_id_idx on public.pipeline_leads (user_id);
create index if not exists pipeline_leads_status_idx on public.pipeline_leads (status);
create index if not exists pipeline_leads_created_at_idx on public.pipeline_leads (created_at desc);

-- updated_at trigger
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists trg_pipeline_leads_updated_at on public.pipeline_leads;
create trigger trg_pipeline_leads_updated_at
  before update on public.pipeline_leads
  for each row execute function public.set_updated_at();

-- RLS: service_role (SUPABASE_SECRET_KEY) bypasses RLS, so no policies needed for server code.
-- Enable it so anon/authenticated cannot read without a policy.
alter table public.pipeline_leads enable row level security;
-- Optional: let the workspace owner read their own leads via JWT (if you later use RLS with user JWTs)
-- Uncomment if you want Time-tracker workspace auth to query directly:
-- drop policy if exists "Owner can read own leads" on public.pipeline_leads;
-- create policy "Owner can read own leads" on public.pipeline_leads for select using (auth.uid() = user_id);

-- ============================================================
-- 2) pipeline_lead_sessions — voice answers + extracted fields + voice metadata
-- ============================================================
create table if not exists public.pipeline_lead_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  lead_id uuid not null references public.pipeline_leads(id) on delete cascade,
  status text not null default 'in_progress' check (status in ('in_progress','completed')),
  call_id text,                       -- voice callId (≤160 chars)
  answers jsonb,                      -- [{id, text}] from the 12-question intake
  extracted_fields jsonb,             -- Section 7 contract (23 fields)
  voice_metadata jsonb,               -- voiceMeta() (provider, turns, realtime_model, etc., audio_retained:false)
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lead_id)                    -- one session row per lead (app PATCHes, not INSERTs many)
);
create index if not exists pipeline_lead_sessions_user_lead_idx on public.pipeline_lead_sessions (user_id, lead_id);
create index if not exists pipeline_lead_sessions_lead_id_idx on public.pipeline_lead_sessions (lead_id);
drop trigger if exists trg_pipeline_lead_sessions_updated_at on public.pipeline_lead_sessions;
create trigger trg_pipeline_lead_sessions_updated_at
  before update on public.pipeline_lead_sessions
  for each row execute function public.set_updated_at();
alter table public.pipeline_lead_sessions enable row level security;

-- ============================================================
-- 3) pipeline_blueprints — generated blueprint JSON + PDF filename
-- ============================================================
create table if not exists public.pipeline_blueprints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  lead_id uuid not null unique references public.pipeline_leads(id) on delete cascade,
  blueprint jsonb not null,           -- full core.generate() output (≤300k)
  generated_at timestamptz not null default now(),
  delivered_at timestamptz,           -- set when PDF is unlocked
  pdf_filename text,                  -- e.g. PipelineSync_Blueprint_Solar_2026-09-19.pdf (≤255)
  pdf_storage_path text,              -- if you later store PDF in Supabase Storage (≤1000)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pipeline_blueprints_user_id_idx on public.pipeline_blueprints (user_id);
create index if not exists pipeline_blueprints_lead_id_idx on public.pipeline_blueprints (lead_id);
drop trigger if exists trg_pipeline_blueprints_updated_at on public.pipeline_blueprints;
create trigger trg_pipeline_blueprints_updated_at
  before update on public.pipeline_blueprints
  for each row execute function public.set_updated_at();
alter table public.pipeline_blueprints enable row level security;

-- ============================================================
-- 4) pipeline_lead_events — append-only timeline (funnel analytics)
-- ============================================================
create table if not exists public.pipeline_lead_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  lead_id uuid not null references public.pipeline_leads(id) on delete cascade,
  event_type text not null check (char_length(event_type) between 1 and 100), -- lead_signed_up, discovery_started, discovery_completed, blueprint_generated, blueprint_delivered, consultation_requested, etc.
  event_data jsonb,                   -- {source:'pipelinesync_ai', filename:'...', hubspot:{contactId, dealId}}
  created_at timestamptz not null default now()
);
create index if not exists pipeline_lead_events_lead_idx on public.pipeline_lead_events (lead_id, created_at desc);
create index if not exists pipeline_lead_events_user_idx on public.pipeline_lead_events (user_id, created_at desc);
create index if not exists pipeline_lead_events_type_idx on public.pipeline_lead_events (event_type);
alter table public.pipeline_lead_events enable row level security;

-- ============================================================
-- 5) Grants — PostgREST needs these for the service_role / secret key
-- (service_role bypasses RLS, but still needs table privileges)
-- ============================================================
grant all on public.pipeline_leads to service_role;
grant all on public.pipeline_lead_sessions to service_role;
grant all on public.pipeline_blueprints to service_role;
grant all on public.pipeline_lead_events to service_role;
-- Optional: if you query leads from a logged-in user JWT, also:
-- grant all on public.pipeline_leads to authenticated;
-- grant all on public.pipeline_lead_sessions to authenticated;
-- grant all on public.pipeline_blueprints to authenticated;
-- grant all on public.pipeline_lead_events to authenticated;

-- ============================================================
-- 6) Verify
-- ============================================================
select
  'pipeline_leads' as table_name, count(*) as rows from public.pipeline_leads
union all select 'pipeline_lead_sessions', count(*) from public.pipeline_lead_sessions
union all select 'pipeline_blueprints', count(*) from public.pipeline_blueprints
union all select 'pipeline_lead_events', count(*) from public.pipeline_lead_events;

-- Done. Next steps printed in comments below.
-- ============================================================
-- NEXT STEPS (copy/paste checklist)
-- ============================================================
-- 1) Get your Supabase project URL + secret key:
--    Supabase Dashboard → Project Settings → API → Project URL (https://<ref>.supabase.co)
--    → API Keys → Secret key (or legacy service_role) — NEVER the anon key.
--
-- 2) Get the workspace owner UUID (the user who owns Time-tracker leads):
--    Supabase Dashboard → SQL Editor → run:
--      select id, email, created_at from auth.users order by created_at asc limit 20;
--    Pick the admin user (usually the first owner) → copy its id (UUID).
--
-- 3) Set env vars (both places):
--    Netlify: Site configuration → Environment variables → Add:
--      SUPABASE_URL=https://<ref>.supabase.co
--      SUPABASE_SECRET_KEY=<secret key>   (or SUPABASE_SERVICE_ROLE_KEY)
--      PIPELINESYNC_WORKSPACE_OWNER_ID=<uuid from step 2>
--      HUBSPOT_ACCESS_TOKEN=pat-na1-...   (already set)
--      SCHEDULER_LINK=https://meetings.hubspot.com/...
--      PS_TOKEN_SECRET=<openssl rand -hex 32>
--    → Deploys → Trigger deploy
--
--    Local (.env in /home/user/AI or your clone):
--      SUPABASE_URL=https://<ref>.supabase.co
--      SUPABASE_SECRET_KEY=<secret>
--      PIPELINESYNC_WORKSPACE_OWNER_ID=<uuid>
--      HUBSPOT_ACCESS_TOKEN=pat-na1-...
--      SCHEDULER_LINK=https://meetings.hubspot.com/...
--      PS_TOKEN_SECRET=local-dev-secret
--    → node server.js
--
-- 4) Test live:
--    Run a demo journey (Solar persona) → Unlock PDF → visit /dev/outbox (local) or check Supabase:
--      select * from pipeline_leads order by created_at desc limit 5;
--      select * from pipeline_lead_sessions order by updated_at desc limit 5;
--      select * from pipeline_blueprints order by generated_at desc limit 5;
--      select * from pipeline_lead_events order by created_at desc limit 10;
--    Netlify Functions → deliver logs should show [hubspot] live push ok (if HubSpot token set) and no Supabase 503 errors.
