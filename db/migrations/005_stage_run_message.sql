-- Floor's last agent message (plan Task 15): the text of a stage's own prompted agent call, cut to 500 characters.
alter table stage_run add column message text;
