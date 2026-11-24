-- PBI 366: an item in FeatureChangeRequest is reminded on the PBI 2 days and 4 days after it moved there, once each, as
-- a question is. The run keeps how many reminders its open request has had. A new request on the run starts it at 0.
alter table run add column feature_change_reminders int not null default 0;
