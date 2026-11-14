-- PBI 262: why a question closed without an answer, such as the factory's merge of the item's PR while the item
-- waited in NeedsInput. Null for a question that was answered, or closed with no note.
alter table question add column closed_note text;
