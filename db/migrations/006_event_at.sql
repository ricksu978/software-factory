-- The activity log (PBI 105) reads the 100 newest events, so it walks this index instead of sorting the whole log.
create index event_at on event (at desc, id desc);
