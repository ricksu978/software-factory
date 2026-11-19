-- PBI 219: the worker now handles outbox rows. A row written by a pre-219 process (PBI 218's code) was already acted on
-- by that process's own after-commit hooks, so handling it again would post a duplicate waiting comment or decision
-- announcement, replay board calls and re-apply an old /approve or /changes to an item's current sign-off question.
-- Old processes keep writing rows after this migration while old and new revisions overlap in a swap (spec §07), so a
-- one-off delete can't catch them all. Instead PBI 219's code records the seq of each row it writes here, in the same
-- statement, and a pre-219 insert records none. The worker deletes the unrecorded rows unhandled (src/worker/outbox.ts),
-- the ones here now and any an old process writes until it stops. It's a table of its own, not a column on `outbox`,
-- so `outbox` keeps exactly the columns §08 lists (PBI 117).
create table outbox_worker_row (
  seq bigint primary key references outbox (seq) on delete cascade
);
grant select, insert, update, delete on outbox_worker_row to factory_app;
