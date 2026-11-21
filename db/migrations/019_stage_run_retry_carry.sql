-- PBI 393: a failed attempt whose cell ended its claim at that attempt boundary, because the factory drained or a
-- restart was being prepared while the stage had retries left: {"tried": 1, "findings": ["..."]}, the tries the stage
-- had spent in that claim and the attempt's findings. The next claim at the stage reads it from its context, so it
-- spends only the retries left and briefs its first attempt with those findings. Null for every other attempt.
alter table stage_run add column retry_carry jsonb;
