-- PBI 220: a board mirror row handled again, after a crash before its removal or after only some of its effects
-- succeeded, repeats no effect that already took place. The worker records each effect of a row here as it succeeds,
-- on its own connection so the record outlives a row whose other effects failed, and skips a recorded effect when it
-- handles the row again. Board calls such as setStatus, claim, release and close carry no idempotency key, and setting a
-- status again would undo a change a person made on the board since. The records go with their row. The worker takes
-- each row `for no key update`, which this table's key share check on `seq` doesn't wait on. It's a table of its own,
-- not a column on `outbox`, so `outbox` keeps exactly the columns §08 lists (PBI 117).
create table outbox_effect (
  seq bigint not null references outbox (seq) on delete cascade,
  effect text not null,
  primary key (seq, effect)
);
grant select, insert, update, delete on outbox_effect to factory_app;
