-- PBI 439: the rewrite the factory proposes for a NotReady item a person wrote that fails only dor.md lines. One row
-- per item and item text, so the coding model is asked once per version of the text. A row with no body records that
-- the coding model's reply carried none. Only the owner accepts a proposal, and a person's edit withdraws it. The
-- worker reads an accepted row it hasn't rechecked yet as a request to run the readiness check at once.
create table item_rewrite (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references item (id),
  text_hash text not null,
  body text,
  current text not null,
  proposed_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid references "user" (id),
  rechecked_at timestamptz,
  withdrawn_at timestamptz,
  unique (item_id, text_hash)
);
grant select, insert, update on item_rewrite to factory_app;
