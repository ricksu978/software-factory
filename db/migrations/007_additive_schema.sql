-- Step 1 of the control plane redesign (2026-11-07 design, §08 and §12): additive only, and nothing reads it yet.

-- A user is known by one of today's providers or by any sign-in issuer. provider goes in step 9, once nothing reads it.
alter table "user" alter column provider drop not null;
alter table "user" add column issuer text;
alter table "user" add constraint user_provider_or_issuer check (provider is not null or issuer is not null);
alter table "user" add constraint user_issuer_subject unique (issuer, subject);

-- The BFF's sessions. The browser's cookie holds a random id, and only its hash is stored. The refresh token is
-- encrypted under the BFF's session key.
create table session (
  cookie_hash text primary key,
  issuer text not null,
  subject text not null,
  refresh_token_encrypted text,
  access_token text not null,
  access_token_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- One row per consumer for each event the worker handles (§07), in seq order and held back per item.
create table outbox (
  seq bigserial primary key,
  consumer text not null,
  event_id uuid not null references event (id),
  item_id uuid references item (id),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  failed_at timestamptz
);
create index outbox_pending on outbox (item_id, seq) where failed_at is null;

-- The time of the worker's last tick. The unique index on a constant keeps it to one row.
create table worker_heartbeat (
  ticked_at timestamptz not null
);
create unique index worker_heartbeat_one_row on worker_heartbeat ((true));

-- The run's acceptance criteria, stored with its scenarios sha (§06).
alter table run add column acceptance_criteria text[];

-- Each locked file's text at the run's scenarios sha (§06). A new scenarios sha replaces the run's rows.
create table run_file (
  run_id uuid not null references run (id),
  sha text not null,
  path text not null,
  text text not null,
  primary key (run_id, path)
);

-- The BFF's role reaches session and nothing else. The API, worker and cell API stay on factory_app.
do $$
begin
  if not exists (select from pg_roles where rolname = 'factory_bff') then
    create role factory_bff nologin;
  end if;
end $$;
grant select, insert, update, delete on session to factory_bff;
-- outbox.seq is the schema's first sequence, and table grants don't cover it.
grant select, insert, update, delete on outbox, worker_heartbeat, run_file to factory_app;
grant usage on sequence outbox_seq_seq to factory_app;
