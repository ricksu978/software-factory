-- PBI 364: a stage after sign-off may ask to change a locked feature file, and the item waits in FeatureChangeRequest.
-- The run keeps the request: each file's path, the stage's reason, its text at the lock commit and the version the
-- stage proposed. Null when the run has made none.
alter table item drop constraint item_state_check;
alter table item add constraint item_state_check
  check (state in ('Eligible', 'NotReady', 'Queued', 'InProgress', 'SignOff', 'NeedsInput', 'InReview', 'Accepted', 'Done', 'Failed', 'Abandoned', 'Split', 'FeatureChangeRequest'));
alter table run add column feature_change jsonb;
