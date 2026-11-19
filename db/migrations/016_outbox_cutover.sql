-- PBI 219: the worker now handles outbox rows. Every row written since PBI 218 began writing them (2026-11-14) was
-- already acted on by the old hooks, so handling them again would post duplicate comments, replay board calls and
-- re-apply old /approve and /changes commands to an item's current sign-off question. Spec §07: the outbox starts
-- empty on the first deploy. Migrations run before the new worker starts, so it never reads these rows.
delete from outbox;
