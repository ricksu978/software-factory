-- PBI 233: each commit whose failed checks a cell asked the control plane to re-run, so a commit's checks are re-run
-- once at most, even across a restart or a lost lease (the next cell resumes the same run). POST /rerun-checks records
-- the re-run here, in the same transaction as the call, and refuses a second one for the same run and sha.
create table ci_rerun (
  run_id uuid not null references run (id),
  sha text not null,
  checks text[] not null,
  requested_at timestamptz not null,
  primary key (run_id, sha)
);
grant select, insert, update, delete on ci_rerun to factory_app;
