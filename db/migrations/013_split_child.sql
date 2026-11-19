-- PBI 227: the issues a parent's split filed, in the order of the split, so Floor and the parent's Run detail can show
-- it as "Split into" with a link to each child. Kept in the same commit that moves the parent to Split.
create table split_child (
  parent_id uuid not null references item (id),
  position int not null,
  external_id text not null,
  title text not null,
  url text not null,
  primary key (parent_id, position)
);
grant select, insert on split_child to factory_app;
