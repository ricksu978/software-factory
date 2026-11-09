-- Each item's repo as owner/name, taken from the issue it came from (PBI 137). Null for a board item that isn't in a
-- repo, and for an item held from before this column until a poll sees it.
alter table item add column repo text;
