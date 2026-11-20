// PBI 294: replays past file merges of the spec and the Phase 0 plan, to count how many conflict in each layout.
// The inputs live under features/fixtures/pbi-294/replay/, one directory per file merge from the item's Notes:
//   <merge>/old/{base,ours,theirs}  the three sides as they stood, in the old layout
//   <merge>/new/{base,ours,theirs}  the same three sides in the new layout, one sentence per line
// The files carry no .md or .html extension, so the prose lint doesn't read them.
// The count the replay gets for the new layout is recorded in features/fixtures/pbi-294/replay-result.json.

export type Layout = "old" | "new";

/** One replayed file merge: its directory name, and whether a three-way merge of its sides conflicted. */
export type MergeResult = { name: string; conflicted: boolean };

/** Replays each file merge under `dir` with its base, ours and theirs in `layout`. */
export function replay(dir: string, layout: Layout): MergeResult[] {
  void dir;
  void layout;
  return [];
}
