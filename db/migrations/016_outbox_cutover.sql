-- PBI 219: the worker now handles outbox rows. A row written by a pre-219 process (PBI 218's code) was already acted on
-- by that process's own after-commit hooks, so handling it again would post a duplicate waiting comment or decision
-- announcement, replay board calls and re-apply an old /approve or /changes to an item's current sign-off question.
-- Old processes keep writing rows after this migration while old and new revisions overlap in a swap (spec §07), so a
-- one-off delete can't catch them all. Instead each row records whether the worker handles it: PBI 219's code writes
-- `true`, and a pre-219 insert, which names no such column, gets the default `false`. The worker deletes those rows
-- unhandled (src/worker/outbox.ts), the ones here now and any an old process writes until it stops.
alter table outbox add column worker_handles boolean not null default false;
