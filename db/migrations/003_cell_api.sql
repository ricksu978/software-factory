-- What a person decided on a question, so GET /context can hand the cell its kind (plan Task 12). decide writes it (Task 15).
alter table question add column decision text check (decision in ('approve', 'changes', 'answer'));

-- Each commit a cell asked about through GET /checks, and when, which starts that sha's 10-minute "none" clock (Run contract 6).
create table check_watch (
  run_id uuid not null references run (id),
  sha text not null,
  first_asked_at timestamptz not null,
  primary key (run_id, sha)
);
grant select, insert, update, delete on check_watch to factory_app;
