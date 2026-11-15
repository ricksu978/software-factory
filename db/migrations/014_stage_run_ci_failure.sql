-- PBI 292: the CI failure a Green attempt was sent back to fix, as the cell reported it when the attempt started: the
-- commit CI failed on and each failed check, {"sha": "...", "checks": [{"name": "...", "url": "...", "failingTests": ["..."]}]},
-- so Floor and the item's page show the item as fixing CI. Null for every other attempt.
alter table stage_run add column ci_failure jsonb;
