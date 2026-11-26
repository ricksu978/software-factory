-- PBI 319: the effort every agent call names, a runtime setting beside current WIP and review capacity. It always has
-- a value, starting at medium, Opus 5.5's own default, so nothing changes until an operator changes it. Each stage
-- attempt and each readiness or split call keeps the effort it ran at. A row from before this migration has none, and
-- ran at medium.
alter table wip_policy add column effort text not null default 'medium';
alter table stage_run add column effort text;
alter table readiness_check add column effort text;
