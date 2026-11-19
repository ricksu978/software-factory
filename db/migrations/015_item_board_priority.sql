-- PBI 320: the item's own priority, 1 to 5 where 1 is the highest, as the poller last read it from the board's
-- Priority field. The poller writes 3 for a missing value or one outside 1 to 5. Null until a poll has read it, which
-- the claim order counts as 3. The priority an item inherits from a PBI that depends on it isn't stored here.
alter table item add column board_priority smallint;
