-- PBI 210: the cell image the worker keeps current with main. started_commit is the checkout's HEAD when the worker
-- started, the commit whose files the control plane and the worker run. built_commit is the commit factory-cell:local was last built from, null
-- until a build succeeds. restart_commit is main's newest commit when it changes code the control plane or the worker
-- runs, so Floor can ask for a restart that picks it up. The unique index on a constant keeps the table to one row.
create table cell_image (
  started_commit text not null,
  built_commit text,
  restart_commit text,
  updated_at timestamptz not null default now()
);
create unique index cell_image_one_row on cell_image ((true));
grant select, insert, update, delete on cell_image to factory_app;
