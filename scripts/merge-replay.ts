// PBI 294: replays past file merges of the spec and the Phase 0 plan, to count how many conflict in each layout.
// The inputs live under features/fixtures/pbi-294/replay/, so the replay needs no git history beyond HEAD:
//   merges.json    one entry per file merge, naming its base, ours and theirs in the old layout and in the new, by id
//   left-out.json  the same for the file merges of the one merge the build leaves out, see below
//   blobs.json.br  each side's text by id, brotli-compressed as one file, since the sides differ little from each other
// The files carry no .md or .html extension, so the prose lint doesn't read them.
// The count the replay gets for the new layout is recorded in features/fixtures/pbi-294/replay-result.json.
//
// Usage, from the repo root:
//   node scripts/merge-replay.ts build   rebuilds the inputs from git history. It needs each PR head fetched first:
//                                        git fetch origin '+refs/pull/*/head:refs/prhead/*'
//   node scripts/merge-replay.ts run     replays both layouts and writes the result file.
//
// Which merges: the 34 merges in PBI 294's Notes, which measured the PR heads as of f700510 on main. A merge counts if
// it is a merge commit on a PR head, made from 2026-11-10 on, that merges in main as it stood before f700510 (its
// second parent is an ancestor of f700510^), and `git merge-tree` finds the spec or the plan conflicting in it. That
// takes in 0dfbd99, which the Notes name, though it came 4 minutes after f700510, and leaves out the merges of
// f700510 itself, which conflict only in code. Each conflicting file in such a merge is one file merge: base is the
// merge base of its parents, ours the first parent, theirs the second.
// The rule finds 35 merges, 49 file merges and 64 conflict hunks in the old layout, one merge more than the Notes'
// 34, 47 and 62. So the Notes leave out one merge with 1 hunk in the spec and 1 in the plan, and 8 merges fit that.
// Neither the Notes nor the history says which, so the build leaves out LEFT_OUT: of the 8, it is the one that
// doesn't conflict in the new layout, so leaving it out gives the highest count any of the 8 would, and the count
// the replay states is an upper bound for the Notes' 47. `run` also replays all 49 and states that count.
// The new layout is each side put through scripts/one-sentence-per-line.ts.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import { reflow } from "./one-sentence-per-line.ts";

export type Layout = "old" | "new";

/** One replayed file merge: its name, and whether a three-way merge of its sides conflicted. */
export type MergeResult = { name: string; conflicted: boolean; hunks: number };

type Sides = { base: string; ours: string; theirs: string };
/** One file merge in merges.json: its name, the merge commit, the file, and each layout's sides by blob id. */
export type FileMerge = { name: string; merge: string; file: string; old: Sides; new: Sides };

const SPEC = "docs/superpowers/specs/2026-11-05-software-factory-design.html";
const PLAN = "docs/superpowers/plans/2026-11-05-phase-0-walking-skeleton.md";
const FIXTURES = "features/fixtures/pbi-294";
const SINCE = "2026-11-10T00:00:00Z";
const MAIN_BEFORE = "f700510^";
const LEFT_OUT = "0b8a06c";
/** What PBI 294's Notes measured: merges, file merges, and conflict hunks in the old layout. */
const NOTES = { merges: 34, fileMerges: 47, hunks: 62 };

/** Reads the inputs under `dir`: the file merges listed in `list`, and every side's text by id. */
export function readInputs(dir: string, list = "merges.json"): { merges: FileMerge[]; blobs: Record<string, string> } {
  const merges = JSON.parse(readFileSync(join(dir, list), "utf8")) as FileMerge[];
  const blobs = JSON.parse(brotliDecompressSync(readFileSync(join(dir, "blobs.json.br"))).toString("utf8")) as Record<string, string>;
  return { merges, blobs };
}

/** Merges `ours` and `theirs` from `base` with `git merge-file`, and counts the conflict hunks. */
export function mergeFile(base: string, ours: string, theirs: string): number {
  const dir = mkdtempSync(join(tmpdir(), "merge-replay-"));
  try {
    for (const [name, text] of Object.entries({ base, ours, theirs })) writeFileSync(join(dir, name), text);
    const r = spawnSync("git", ["merge-file", "-p", "-q", "ours", "base", "theirs"], { cwd: dir, encoding: "utf8", maxBuffer: 64 << 20 });
    // git merge-file exits with the number of conflicts, or with a negative status, read as 255, on an error.
    if (r.status === null || r.status > 127 || r.error) throw new Error(`git merge-file failed: ${r.stderr || r.error}`);
    return r.status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Replays each file merge listed in `list` under `dir`, with its base, ours and theirs in `layout`. */
export function replay(dir: string, layout: Layout, list = "merges.json"): MergeResult[] {
  const { merges, blobs } = readInputs(dir, list);
  return merges.map((m) => {
    const s = m[layout];
    const hunks = mergeFile(blobs[s.base], blobs[s.ours], blobs[s.theirs]);
    return { name: m.name, conflicted: hunks > 0, hunks };
  });
}

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 });
const id = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Rebuilds the inputs from git history, by the rule at the top of this file. */
function build(out: string) {
  const heads = git("for-each-ref", "--format=%(refname)", "refs/prhead").split("\n").filter(Boolean);
  if (!heads.length) throw new Error("no PR heads under refs/prhead; fetch them first");
  const commits = git("rev-list", "--merges", `--since=${SINCE}`, "--format=%ct %P", ...heads).split("\n");
  const isAncestor = (a: string, b: string) => spawnSync("git", ["merge-base", "--is-ancestor", a, b]).status === 0;
  const merges: { sha: string; time: number }[] = [];
  for (let i = 0; i + 1 < commits.length; i += 2) {
    const sha = commits[i].replace(/^commit /, "");
    const [time, , theirs] = commits[i + 1].split(" ");
    if (isAncestor(theirs, MAIN_BEFORE)) merges.push({ sha, time: Number(time) });
  }
  merges.sort((a, b) => a.time - b.time || a.sha.localeCompare(b.sha));
  const blobs: Record<string, string> = {};
  const put = (text: string) => ((blobs[id(text)] = text), id(text));
  const list: FileMerge[] = [];
  for (const { sha } of merges) {
    const [ours, theirs] = git("log", "-1", "--format=%P", sha).trim().split(" ");
    const r = spawnSync("git", ["merge-tree", "--write-tree", "--name-only", ours, theirs], { encoding: "utf8", maxBuffer: 64 << 20 });
    if (r.status !== 1) continue;
    const conflicted = r.stdout.split("\n\n")[0].split("\n").slice(1);
    const base = git("merge-base", ours, theirs).trim();
    for (const file of [SPEC, PLAN]) {
      if (!conflicted.includes(file)) continue;
      const ext = file.endsWith(".html") ? ".html" : ".md";
      const text = (c: string) => git("show", `${c}:${file}`);
      const sides = { base: text(base), ours: text(ours), theirs: text(theirs) };
      list.push({
        name: `${sha.slice(0, 7)}-${file === SPEC ? "spec" : "plan"}`,
        merge: sha,
        file,
        old: { base: put(sides.base), ours: put(sides.ours), theirs: put(sides.theirs) },
        new: { base: put(reflow(sides.base, ext)), ours: put(reflow(sides.ours, ext)), theirs: put(reflow(sides.theirs, ext)) },
      });
    }
  }
  const hunks = list.reduce((n, m) => n + mergeFile(blobs[m.old.base], blobs[m.old.ours], blobs[m.old.theirs]), 0);
  const all = { merges: new Set(list.map((m) => m.merge)).size, fileMerges: list.length, hunks };
  const left = list.filter((m) => m.merge.startsWith(LEFT_OUT));
  const kept = list.filter((m) => !m.merge.startsWith(LEFT_OUT));
  const keptHunks = kept.reduce((n, m) => n + mergeFile(blobs[m.old.base], blobs[m.old.ours], blobs[m.old.theirs]), 0);
  const got = { merges: new Set(kept.map((m) => m.merge)).size, fileMerges: kept.length, hunks: keptHunks };
  if (JSON.stringify(got) !== JSON.stringify(NOTES)) {
    throw new Error(`the rule finds ${JSON.stringify(all)}, and without ${LEFT_OUT} ${JSON.stringify(got)}, not the Notes' ${JSON.stringify(NOTES)}`);
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "left-out.json"), `${JSON.stringify(left, null, 1)}\n`);
  list.length = 0;
  list.push(...kept);
  writeFileSync(join(out, "merges.json"), `${JSON.stringify(list, null, 1)}\n`);
  const packed = brotliCompressSync(JSON.stringify(blobs), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24 },
  });
  writeFileSync(join(out, "blobs.json.br"), packed);
  console.log(`${list.length} file merges from ${new Set(list.map((m) => m.merge)).size} merges, ${Object.keys(blobs).length} sides`);
}

/** Replays both layouts and writes the result file the PR cites. */
function run(dir: string, resultFile: string) {
  const old = replay(dir, "old");
  const now = replay(dir, "new");
  const left = replay(dir, "new", "left-out.json");
  const count = (rs: MergeResult[]) => rs.filter((r) => r.conflicted).length;
  const hunks = (rs: MergeResult[]) => rs.reduce((n, r) => n + r.hunks, 0);
  const result = {
    note: "PBI 294's merge replay: each file merge under replay/ through git merge-file, as node scripts/merge-replay.ts run writes it. replayed and conflicted are for the new layout.",
    replayed: now.length,
    conflicted: count(now),
    hunks: hunks(now),
    old: { conflicted: count(old), hunks: hunks(old) },
    conflicts: now.filter((r) => r.conflicted).map((r) => r.name),
    leftOut: {
      note: `The merge the build leaves out to match the Notes' 34 merges (see scripts/merge-replay.ts), and the count with it put back.`,
      fileMerges: left.map((r) => r.name),
      conflicted: count(left),
      replayedWithIt: now.length + left.length,
      conflictedWithIt: count(now) + count(left),
    },
  };
  writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    `old layout: ${result.old.conflicted} of ${old.length} conflict, ${result.old.hunks} hunks; new layout: ${result.conflicted} of ${now.length}, ${result.hunks} hunks; ` +
      `with ${LEFT_OUT} put back: ${result.leftOut.conflictedWithIt} of ${result.leftOut.replayedWithIt}`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const dir = join(FIXTURES, "replay");
  if (process.argv[2] === "build") build(dir);
  else if (process.argv[2] === "run") run(dir, join(FIXTURES, "replay-result.json"));
  else {
    console.error("usage: node scripts/merge-replay.ts build|run");
    process.exit(1);
  }
}
