-- PBI 283: Run detail's Scope, the issue's body as the board held it when the run's snapshot was stored (PBI 224), so
-- the API shows it while the item waits for sign-off without reading GitHub. Null for a run stored before this.
alter table run add column issue_body text;
