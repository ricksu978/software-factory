-- PBI 239: a cell that died mid-stage never reported its attempt, so the attempt stayed started for good. The factory
-- now closes such attempts when the cell's lease runs out. This closes the ones left before that change: every started
-- attempt whose run has a later attempt, or has ended, is stopped now, with the same message the factory writes
-- (LEASE_RAN_OUT in src/store/items.ts). The newest attempt of an open run stays started, as its cell may still run.
update stage_run s set status = 'stopped', ended_at = now(), message = 'The cell''s lease ran out before it reported this attempt.'
from run r
where r.id = s.run_id and s.status = 'started'
  and (r.ended_at is not null
    or exists (select from stage_run later where later.run_id = s.run_id and later.started_at > s.started_at));
