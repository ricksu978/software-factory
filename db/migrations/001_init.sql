-- The Phase 0 schema: spec §12's tables plus plan Task 4's Phase 0 columns.
-- increment and approval belong to Phase 1 and are left out.

create table backlog_source (
  id uuid primary key default gen_random_uuid(),
  adapter text not null,
  url text not null unique,
  owner_type text,
  owner_login text,
  project_number int,
  field_map jsonb not null default '{}',
  label_filter text,
  repo_map jsonb not null default '{}',
  paused boolean not null default false,
  cursor text
);

create table repo (
  id uuid primary key default gen_random_uuid(),
  host_adapter text not null,
  url text not null unique,
  installation_id bigint,
  trusted_bot text,
  trusted_set_by text,
  config_sha text,
  quarantined_at timestamptz
);

create table "user" (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('google', 'microsoft', 'dev')),
  subject text not null,
  tenant_id text,
  email text,
  github_login text unique,
  role text not null check (role in ('viewer', 'operator', 'owner')),
  product_owner boolean not null default false,
  added_by uuid references "user" (id),
  added_at timestamptz not null default now(),
  unique (provider, subject)
);

create table item (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references backlog_source (id),
  external_id text not null,
  title text not null,
  state text not null check (state in ('Eligible', 'NotReady', 'Queued', 'InProgress', 'SignOff', 'NeedsInput', 'InReview', 'Accepted', 'Done', 'Failed', 'Abandoned')),
  backlog_rank text,
  readiness_notes text,
  readiness_policy_sha text,
  criteria_hash text,
  lease_owner text,
  lease_generation int not null default 0,
  lease_expires timestamptz,
  held boolean not null default false,
  priority int not null default 0,
  unique (source_id, external_id)
);

create table run (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references item (id),
  repo_id uuid references repo (id),
  run_number int not null default 1,
  sop_version text,
  config_sha text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  outcome text,
  cost_usd numeric not null default 0,
  branch text,
  pr_url text,
  pr_number int,
  next_stage text,
  scenarios_sha text,
  locked_files text[],
  features_lock_sha text,
  signed_off_by uuid references "user" (id),
  signed_off_at timestamptz,
  reviews_seen_at timestamptz,
  merge_sha text,
  resume_at timestamptz,
  execution_name text,
  risk_tier text check (risk_tier in ('Low', 'Medium', 'High')),
  tier_reasons text[]
);

create table stage_run (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references run (id),
  stage_id text not null,
  attempt int not null,
  model text,
  status text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  tokens_in int,
  tokens_out int,
  cost_usd numeric,
  transcript_ref text,
  report_ref text
);

create table question (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references item (id),
  stage_run_id uuid references stage_run (id),
  kind text not null check (kind in ('needs_input', 'sign_off')),
  body text not null,
  asked_at timestamptz not null default now(),
  reminders_sent int not null default 0,
  comment_url text,
  answer text,
  answered_by uuid references "user" (id),
  answered_at timestamptz
);

create table policy_result (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references item (id),
  run_id uuid references run (id),
  file text not null check (file in ('dor', 'pr-review', 'dod')),
  source text not null check (source in ('repo', 'default')),
  stage_id text,
  attempt int,
  checked_sha text,
  criterion_index int not null,
  criterion text not null,
  status text not null check (status in ('passed', 'failed', 'person')),
  reason text,
  evidence_ref text,
  at timestamptz not null default now()
);

-- Append only: factory_app gets SELECT and INSERT here and nothing else.
create table event (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default clock_timestamp(),
  actor text not null check (actor in ('agent', 'human', 'system')),
  actor_id text not null,
  item_id uuid references item (id),
  kind text not null,
  payload jsonb not null default '{}'
);
create index event_item_at on event (item_id, at);

create table wip_policy (
  id uuid primary key default gen_random_uuid(),
  mode text not null default 'fixed',
  wip_min int not null default 1,
  wip_max int not null default 1,
  review_capacity int not null default 3,
  usage_reserve_at numeric not null default 0.7,
  usage_paused_until timestamptz,
  daily_budget numeric,
  current_wip int not null default 1,
  computed_at timestamptz,
  inputs jsonb
);
insert into wip_policy (mode, current_wip) values ('fixed', 1);

create table override (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('factory', 'backlog', 'item')),
  target_id uuid,
  kind text not null,
  value jsonb,
  reason text not null check (reason <> ''),
  created_by uuid references "user" (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  cleared_at timestamptz,
  cleared_by uuid references "user" (id)
);

create table webhook_delivery (
  id text primary key,
  received_at timestamptz not null default now()
);

-- The role the control plane runs as. In Azure its managed identity maps to it (plan Task 19).
do $$
begin
  if not exists (select from pg_roles where rolname = 'factory_app') then
    create role factory_app nologin;
  end if;
end $$;
grant select, insert, update, delete on backlog_source, repo, "user", item, run, stage_run, question, policy_result, wip_policy, override, webhook_delivery to factory_app;
grant select, insert on event to factory_app;
