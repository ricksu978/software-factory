-- PBI 311: why an override ended, when something other than a person cleared it. 'board_order' marks a Move up or Move
-- down the board ended by putting the moved item and the item it passed in the other order. Null otherwise.
alter table override add column cleared_cause text;
