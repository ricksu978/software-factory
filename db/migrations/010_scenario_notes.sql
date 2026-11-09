-- PBI 152: the approving self-review round's scenario notes, kept with the run so an open-pr in a later claim still
-- writes them into the PR body for the person who merges.
alter table run add column scenario_notes text[] not null default '{}';
