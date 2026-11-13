-- PBI 225: a parent whose split is filed rests in a Split state of its own, not Abandoned.
alter table item drop constraint item_state_check;
alter table item add constraint item_state_check
  check (state in ('Eligible', 'NotReady', 'Queued', 'InProgress', 'SignOff', 'NeedsInput', 'InReview', 'Accepted', 'Done', 'Failed', 'Abandoned', 'Split'));
