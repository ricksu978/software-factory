-- PBI 215: a needs_input question a cell asked because a Definition of Done line fails the same tests on the base
-- commit, with that commit and the tests, {"sha": "...", "tests": ["..."]}, so Floor can show the base fails in cells.
-- Null for every other question.
alter table question add column base_failure jsonb;
