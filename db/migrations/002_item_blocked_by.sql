-- The item's open dependencies, by external id. The poller copies them from the backlog (plan Task 8),
-- and claimNext skips an item while any remain (plan Task 5).
alter table item add column blocked_by text[] not null default '{}';
