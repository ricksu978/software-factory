-- PBI 190: each time a PR review attempt asked the PR reviewer to restate an answer it couldn't read, by round, with
-- why, so Run detail shows the reviewer needed a second ask.
alter table stage_run add column restates jsonb not null default '[]';
