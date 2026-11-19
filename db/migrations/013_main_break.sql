-- PBI 255: a merge commit that broke a repo's main branch. CI failed a check on it that passed on its first parent, so
-- the item whose merge it was is charged, and the factory files one bug item for it. The break stands until CI passes
-- on a later commit of the branch, which sets cleared_at and cleared_sha. Floor shows a standing break as the branch
-- being red. failed_checks holds [{"name": "...", "url": "...", "tests": ["..."]}].
create table main_break (
  id uuid primary key default gen_random_uuid(),
  repo_id uuid not null references repo (id),
  branch text not null,
  merge_sha text not null,
  item_id uuid references item (id),
  pr_number int,
  failed_checks jsonb not null default '[]',
  -- The bug item on the board, and the factory's own row for it once it holds one.
  bug_external_id text,
  bug_item_id uuid references item (id),
  at timestamptz not null default now(),
  cleared_at timestamptz,
  cleared_sha text,
  unique (repo_id, merge_sha)
);

-- PBI 255: the branch an Accepted item waits on, because CI failed on its merge commit the same checks it failed on
-- the commit's first parent, so the item isn't charged. Null for every other run.
alter table run add column waits_on_branch text;
