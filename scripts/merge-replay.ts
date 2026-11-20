// PBI 294: replays past file merges of the spec and the Phase 0 plan, to count how many conflict in each layout.
// The inputs live under features/fixtures/pbi-294/replay/, so the replay needs no git history beyond HEAD:
//   merges.json    one entry per file merge, naming its base, ours and theirs in the old layout and in the new, by id
//   blobs.json.br  each side's text by id, brotli-compressed as one file, since the sides differ little from each other
// The files carry no .md or .html extension, so the prose lint doesn't read them.
// The count the replay gets for the new layout is recorded in features/fixtures/pbi-294/replay-result.json.
//
// Usage, from the repo root:
//   node scripts/merge-replay.ts build   rebuilds the inputs from git history. It needs each PR head fetched first:
//                                        git fetch origin '+refs/pull/*/head:refs/prhead/*'
//   node scripts/merge-replay.ts run     replays both layouts and writes the result file.
//
// Which merges: as PBI 294's Notes measured them, each merge commit on a PR head, made from 2026-11-10 up to the
// commit time of f700510 on main, that `git merge-tree` finds conflicting in the spec or the plan. Each conflicting
// file in such a merge is one file merge: base is the merge base of its parents, ours the first parent, theirs the
// second. The new layout is each side put through scripts/one-sentence-per-line.ts.
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
const UNTIL_COMMIT = "f700510";

/** Reads the inputs under `dir`: the file merges, and every side's text by id. */
export function readInputs(dir: string): { merges: FileMerge[]; blobs: Record<string, string> } {
  const merges = JSON.parse(readFileSync(join(dir, "merges.json"), "utf8")) as FileMerge[];
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

/** Replays each file merge under `dir` with its base, ours and theirs in `layout`. */
export function replay(dir: string, layout: Layout): MergeResult[] {
  const { merges, blobs } = readInputs(dir);
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
  const until = Number(git("log", "-1", "--format=%ct", UNTIL_COMMIT).trim());
  const heads = git("for-each-ref", "--format=%(refname)", "refs/prhead").split("\n").filter(Boolean);
  if (!heads.length) throw new Error("no PR heads under refs/prhead; fetch them first");
  const commits = git("rev-list", "--merges", `--since=${SINCE}`, "--format=%ct", ...heads).split("\n");
  const merges: { sha: string; time: number }[] = [];
  for (let i = 0; i + 1 < commits.length; i += 2) {
    const sha = commits[i].replace(/^commit /, "");
    const time = Number(commits[i + 1]);
    if (time <= until) merges.push({ sha, time });
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
  mkdirSync(out, { recursive: true });
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
  const count = (rs: MergeResult[]) => rs.filter((r) => r.conflicted).length;
  const hunks = (rs: MergeResult[]) => rs.reduce((n, r) => n + r.hunks, 0);
  const result = {
    note: "PBI 294's merge replay: each file merge under replay/ through git merge-file, as node scripts/merge-replay.ts run writes it. replayed and conflicted are for the new layout.",
    replayed: now.length,
    conflicted: count(now),
    hunks: hunks(now),
    old: { conflicted: count(old), hunks: hunks(old) },
    conflicts: now.filter((r) => r.conflicted).map((r) => r.name),
  };
  writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`old layout: ${result.old.conflicted} of ${old.length} conflict, ${result.old.hunks} hunks; new layout: ${result.conflicted} of ${now.length}, ${result.hunks} hunks`);
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
