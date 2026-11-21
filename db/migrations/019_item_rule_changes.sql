-- PBI 395: the rule changes the item's last readiness check read from its "## Changes the factory's rules" section,
-- in the section's order, each with its place, Before, After and what's wrong with its entry, if anything. An empty
-- list when the item has no such section, and null until a readiness check has read the item since PBI 395.
alter table item add column rule_changes jsonb;
