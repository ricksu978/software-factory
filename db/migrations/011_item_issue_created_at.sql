-- PBI 187: when the item's issue was created, so Run detail can show the item's total time from it. Null for an item
-- held from before this column until a poll sees it.
alter table item add column issue_created_at timestamptz;
