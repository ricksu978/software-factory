-- PBI 366: an item waits on the Product Owner in FeatureChangeRequest and the factory reminds the owner on the PBI 2 and
-- 4 days after the move, once each. The run counts the reminders sent for its open request, and a new request starts
-- the count again.
alter table run add column feature_change_reminders smallint not null default 0;
