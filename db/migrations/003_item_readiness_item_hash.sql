-- What the readiness check last judged, as a hash of the item's title, body, criteria, fields and repo (plan Task 8).
-- The poller re-gates a NotReady item only when this changes, so the factory's own board writes don't re-gate it.
alter table item add column readiness_item_hash text;
