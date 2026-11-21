-- PBI 378: whether the item carries the board's "bug" label, as the poller last read it, on every poll as it reads the
-- Priority field. Only the item's own label counts: an item that takes a priority or the final-stage group from an item
-- that depends on it doesn't take that item's label. False until a poll has read it.
alter table item add column bug_label boolean not null default false;
