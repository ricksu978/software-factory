-- PBI 144: the split the factory files for an item, kept before the first child is filed. A filing that stopped
-- partway is finished from this row after a restart, so the factory files the children it started with, not a
-- second answer from the coding model. One row per item and item text: a new text is a new split.
create table item_split (
  item_id uuid not null references item (id),
  text_hash text not null,
  children jsonb not null,
  created_at timestamptz not null default now(),
  primary key (item_id, text_hash)
);
grant select, insert on item_split to factory_app;
