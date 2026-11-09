-- PBI 132: one row per readiness judge call, with what it spent, whether it answered or failed. Run detail lists an
-- item's checks and the Phase 0 report sums them across every item, the ones the gate turned away included.
create table readiness_check (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references item (id),
  model text not null,
  tokens_in int not null,
  tokens_out int not null,
  cost_usd numeric not null,
  ran_at timestamptz not null
);
create index readiness_check_item on readiness_check (item_id, ran_at);
grant select, insert on readiness_check to factory_app;
