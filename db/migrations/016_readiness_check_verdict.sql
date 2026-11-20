-- PBI 348: what each readiness judge call decided, so Run detail's Readiness checks table can show it. verdict is
-- {"outcome": "passed"}, {"outcome": "failed", "lines": [{"criterion", "reason"}], "flags": [...]},
-- {"outcome": "unreadable"} or {"outcome": "error"}. child is the title of the proposed split child the call judged,
-- when the gate recorded it against that child's parent. Both are null on a split call and on a check recorded before
-- this migration.
alter table readiness_check add column verdict jsonb, add column child text;
