// Dashboard HTML (plan Task 15). Every value goes through escapeHtml, and colours are custom properties with a
// dark-mode override.
import { formatDuration, type ItemDurations } from "../core/durations.ts";
import type { SplitChildView } from "../store/splits.ts";
import type { ClaimKey } from "../store/items.ts";
import type { StoredReadinessCheck } from "../store/readiness-checks.ts";
import { withEffort } from "../store/effort.ts";
import { placeKey, placeName, ruleChangesHash, wordDiff, type DiffWord, type RuleChangeRead } from "../gate/rule-changes.ts";
import { lineDiff, type DiffLine, type FeatureChangeFile } from "../core/feature-change.ts";
import { pauseActive } from "./configuration.ts";
import { issueUrl } from "../core/links.ts";
import { cost, localTime, timeSpent, tokens } from "./format.ts";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const css = `
:root { --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --accent: #0969da; --warn-bg: #fff8c5; --warn-fg: #3b2300; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --accent: #4493f8; --warn-bg: #3b2e00; --warn-fg: #f2cc60; }
}
body { background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 72rem; padding: 1rem; }
a { color: var(--accent); }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid var(--line); padding: .35rem .5rem; text-align: left; vertical-align: top; }
.muted { color: var(--muted); }
.badge { border: 1px solid var(--line); border-radius: 1rem; font-size: .8rem; padding: 0 .5rem; }
.banner { background: var(--warn-bg); color: var(--warn-fg); padding: .5rem 1rem; }
.sides { display: grid; gap: 1rem; grid-template-columns: 1fr 1fr; }
.sides blockquote { border-left: 3px solid var(--line); margin: 0; padding: 0 .75rem; }
mark { background: var(--warn-bg); color: var(--warn-fg); }
label { display: block; margin: .5rem 0 .25rem; }
pre { overflow-x: auto; }
pre.scope { font: inherit; white-space: pre-wrap; }
`;

export function page(title: string, body: string, banner: string | null = null): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${css}</style></head><body>
${banner ? `<p class="banner" role="status">${escapeHtml(banner)}</p>` : ""}<header><a href="/">Floor</a></header><main>${body}</main></body></html>`;
}

export function noAccessPage(): string {
  return page("No access", "<h1>No access</h1><p>You don't have access to this factory. Ask an owner to add you.</p>");
}

export function signInPage(): string {
  return page("Sign in", "<h1>Sign in</h1><p>Sign in to use the factory dashboard.</p>");
}

/** The issue an item is: its number, and its GitHub repo as owner/name, or null when the factory can't tell (PBI 131). */
export type Issue = { external_id: string; repo: string | null };

/** The PR an item's open run holds (PBI 145). A row with no open run, or a run with no PR yet, leaves these null. */
export type OpenPr = { pr_number?: number | null; pr_url?: string | null };

export type ActiveRow = Issue & OpenPr & { id: string; title: string; state: string; stage: string | null; since: Date | null; cost: string; badges: string[]; message: string | null;
  /** PBI 292: the CI failure the item's Green attempt is fixing, or null when it fixes none. */
  ci_failure?: CiFailure | null };
/** PBI 292: a CI failure on a commit one of the run's stages pushed, as the cell reported it for Green to fix. */
export type CiFailure = { sha: string; checks: { name: string; url: string; failingTests: string[] }[] };
export type WaitingRow = Issue & OpenPr & { id: string; title: string; state: string; since: Date | null };
export type NotReadyRow = Issue & { id: string; title: string; failed: string[] };
/** A Queued item held back by its open dependencies, as the issue numbers GitHub lists as blocking it (PBI 237). */
export type BlockedRow = Issue & { id: string; title: string; blocked_by: string[] };
/** An item waiting on a question that blames the base (PBI 215): the base commit and the tests that fail on it. */
export type BaseFailRow = Issue & { id: string; title: string; sha: string; tests: string[] };
/**
 * A break on main that still stands (PBI 255): the merge commit that broke the branch, the PR and the item it came
 * from, and its bug item, which is null until the factory has filed it, with the factory's own row once it holds one.
 */
export type MainBreakRow = { branch: string; sha: string; repo: string; pr_number: number | null; charged: string | null;
  bug_external_id: string | null; bug_id: string | null; bug_title: string | null; bug_state?: string | null };

export function age(since: Date | null, now = Date.now()): string {
  if (!since) return "";
  const minutes = Math.max(0, Math.round((now - since.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

/** A time in UTC to the minute, with its full ISO form in the markup. */
const utc = (at: Date) => `<time datetime="${escapeHtml(at.toISOString())}">${escapeHtml(at.toISOString().slice(0, 16).replace("T", " "))}</time>`;
/** A time to the minute in the viewer's zone (PBI 189), with its full ISO form in the markup. */
const local = (at: Date, zone: string) => `<time datetime="${escapeHtml(at.toISOString())}">${escapeHtml(localTime(at, zone))}</time>`;
/**
 * A readiness check's Verdict cell (PBI 348): what its judge call decided, with each failed dor.md line and the judge's
 * reason and each flag, or why it has no verdict. A judge call on a proposed split child names the child. A split
 * proposal's cell is empty.
 */
function checkVerdict(c: RunDetail["readiness"][number]): string {
  if (c.kind === "split") return "";
  const v = c.verdict;
  const said = !v ? "No verdict was recorded"
    : v.outcome === "passed" ? "Passed"
    : v.outcome === "unreadable" ? escapeHtml("No verdict: the judge's output was unreadable")
    : v.outcome === "error" ? "The call failed with no verdict"
    : `Failed<ul>${[...v.lines.map((l) => `${l.criterion}: ${l.reason}`), ...v.flags.map((f) => `Flag: ${f}`)].map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`;
  return c.child === undefined ? said : `On the proposed child “${escapeHtml(c.child)}”: ${said}`;
}

/** A readiness judge call costs fractions of a cent, so its spend shows to four places. */
const judgeUsd = (n: number) => `$${n.toFixed(4)}`;

const link = (id: string, title: string) => `<a href="/items/${escapeHtml(id)}">${escapeHtml(title)}</a>`;

/**
 * "#N" for an item's issue, linked to it on GitHub when its repo is known. A number that isn't one, or an unknown
 * repo, shows as plain text, since a link to the wrong issue is worse than none. An event with no item shows nothing.
 */
export function issueRef(externalId: string | null, repo: string | null): string {
  if (externalId === null) return "";
  const text = `#${escapeHtml(externalId)}`;
  const url = issueUrl(repo, externalId);
  return url ? `<a href="${escapeHtml(url)}">${text}</a>` : text;
}

/**
 * "PR #N" for an InReview item, linked to the PR its open run holds (PBI 145): the address is the run's pr_url and the
 * text its pr_number. With either missing there's no link, since a guessed address may point at the wrong PR.
 */
export function prLink(r: OpenPr & { state: string }): string {
  if (r.state !== "InReview" || !r.pr_url || r.pr_number == null) return "";
  return `<a href="${escapeHtml(r.pr_url)}">PR #${escapeHtml(r.pr_number)}</a>`;
}

const withPr = (r: OpenPr & { state: string }) => {
  const pr = prLink(r);
  return pr ? ` ${pr}` : "";
};

/** An item as a page names it: "#N", then its title linking to Run detail. */
const named = (r: Issue & { id: string; title: string }) => `${issueRef(r.external_id, r.repo)} ${link(r.id, r.title)}`;

/**
 * Floor's note on an item's claim key (PBI 320): its priority, and whether it's final-stage, each naming the item that
 * depends on it where the priority or the group comes from that item, after a "bug" badge for a bug item (PBI 378).
 */
export function standing(k: ClaimKey | undefined): string {
  if (!k) return "";
  const from = k.priorityFrom ? `, from #${escapeHtml(k.priorityFrom.externalId)}` : "";
  const group = k.finalStage ? `, final-stage${k.finalStageFrom ? ` because of #${escapeHtml(k.finalStageFrom.externalId)}` : ""}` : "";
  // PBI 378: only the item's own "bug" label is marked, never one of an item it takes its priority or group from.
  const bug = k.bug ? ` <span class="badge">bug</span>` : "";
  return `${bug} <span class="muted">priority ${k.priority}${from}${group}</span>`;
}

/**
 * The item page's lines on its claim key (PBI 320). An item that isn't final-stage never has the word on its page, and
 * one without the "bug" label never has that word (PBI 378).
 */
export function claimLines(k: ClaimKey): string {
  const priority = k.priorityFrom
    ? `Priority ${k.priority}, from #${escapeHtml(k.priorityFrom.externalId)}, which depends on it. Its own priority on the board is ${k.own}.`
    : `Priority ${k.priority}.`;
  const group = !k.finalStage ? ""
    : k.finalStageFrom ? ` Final-stage because #${escapeHtml(k.finalStageFrom.externalId)} depends on it, so it's claimed ahead of other work while that dependency stands.`
    : " Final-stage: its PR is open and it's in the review loop, so it's claimed ahead of other work.";
  // PBI 378: the item's own "bug" label puts it first within its priority in the final-stage group, and at priority 1.
  const bug = !k.bug ? ""
    : k.finalStage ? ` Carries the bug label, so it's claimed before the items at priority ${k.priority} in the final-stage group that don't.`
    : k.priority === 1 ? " Carries the bug label, so it's claimed before the priority-1 items outside the final-stage group that don't."
    : " Carries the bug label, which puts it first only in the final-stage group or at priority 1.";
  return `<p>${priority}${group}${bug}</p>`;
}

/** A form posting one override to /overrides. The reason is required, so the browser asks for it first. */
function overrideForm(kinds: [kind: string, label: string][], itemId: string | null): string {
  const id = itemId ? `-${escapeHtml(itemId)}` : "";
  return `<form method="post" action="/overrides">${itemId ? `<input type="hidden" name="itemId" value="${escapeHtml(itemId)}">` : ""}
<label for="reason${id}">Reason</label><input id="reason${id}" name="reason" required>
<p>${kinds.map(([k, label]) => `<button name="kind" value="${k}">${label}</button>`).join(" ")}</p></form>`;
}

const factoryState: Record<string, string> = { pause: "Paused", drain: "Draining", kill: "Killed" };

/** A restart being prepared (PBI 140): how many cells still run. The factory stops none of them (PBI 300). */
export type Restart = { running: number; reason?: string };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Floor's line for a restart being prepared (PBI 140, PBI 302): how many cells still run, with no deadline, since the
 * factory stops none of them (PBI 300). Once none runs, that it's safe to restart.
 */
function restartStatus(r: Restart): string {
  const why = r.reason ? ` Reason: ${escapeHtml(r.reason)}.` : "";
  const text = r.running > 0
    ? `Preparing to restart: ${plural(r.running, "cell", "cells")} still running. The factory won't stop ${r.running === 1 ? "it" : "them"}.`
    : "Ready to restart. No cell is running, so it's safe to restart the factory or stop Docker.";
  return `<p class="banner" role="status">${escapeHtml(text)}${why}</p>`;
}

/**
 * Floor's line for a drain (PBI 316): how many cells still run, counted as Prepare restart counts them, then, once none
 * runs, that the drain is done and it's safe to restart. Without a count, the drain shows its reason alone.
 */
function drainStatus(reason: string, running: number | undefined): string {
  if (running === undefined) return `<p class="banner" role="status">Draining: ${escapeHtml(reason)}</p>`;
  const text = running > 0
    ? `Draining: ${plural(running, "cell", "cells")} still running.`
    : "Drain done. No cell is running, so it's safe to restart the factory or stop Docker.";
  return `<p class="banner" role="status">${escapeHtml(text)} Reason: ${escapeHtml(reason)}.</p>`;
}

/**
 * Why a blocked item waits. A blocker shows as plain "#N", not a link: GitHub may list a blocker from another repo, and
 * a link to the wrong issue is worse than none.
 */
export function blockedReason(deps: string[]): string {
  const refs = deps.map((d) => `#${d}`);
  const names = refs.length === 1 ? refs[0] : `${refs.slice(0, -1).join(", ")} and ${refs[refs.length - 1]}`;
  return `Waits on ${names}, ${refs.length === 1 ? "which is" : "which are"} still open. It starts once ${refs.length === 1 ? "it closes" : "they close"}.`;
}

/** The cell image the worker keeps current with main (PBI 210): the commit it was built from, and main's commit a restart would pick up. */
export type CellImage = { built: string | null; restart: string | null };

const shortSha = (sha: string) => escapeHtml(sha.slice(0, 7));

/** Floor's lines for the cell image: the commit it was built from, then a restart's commit when main's changes need one. */
function cellImageStatus(c: CellImage): string {
  const built = `<p class="muted">The cell image was built from commit ${c.built ? `<code>${shortSha(c.built)}</code>` : "not known: it carries no commit label, as an image built from a checkout with uncommitted edits doesn't"}.</p>`;
  const restart = c.restart
    ? `<p class="banner" role="status">A restart is needed to pick up main's commit <code>${shortSha(c.restart)}</code>. It changes code the control plane or the worker runs, so the cell image isn't rebuilt until the factory restarts.</p>`
    : "";
  return built + restart;
}

/** A Split parent on Floor (PBI 227): the item, and the children its split filed, in order. */
export type SplitRow = Issue & { id: string; title: string; children: SplitChildView[] };

/**
 * A Split parent's children (PBI 227), in the order of the split: each child's "#N" linking to its issue, its title, and
 * the state the factory holds it in, or "Not in the factory" while it holds none: no poll has listed the child yet,
 * or the child is without the opt-in label, because the owner took it off or a split of a factory-filed item filed it
 * unlabelled (PBI 237). A URL that isn't a web address makes no link.
 */
function splitInto(children: SplitChildView[]): string {
  const ref = (k: SplitChildView) => (/^https?:\/\//.test(k.url) ? `<a href="${escapeHtml(k.url)}">#${escapeHtml(k.externalId)}</a>` : `#${escapeHtml(k.externalId)}`);
  return `<ol class="split-into">${children.map((k) => `<li>${ref(k)} ${escapeHtml(k.title)} <span class="muted">${escapeHtml(k.state ?? "Not in the factory")}</span></li>`).join("")}</ol>`;
}

/**
 * A failed check's name, linked to its URL. POST /stage takes only https URLs under the run's repo, and any other
 * stored URL shows the name as plain text, so a link a cell sent can't run script on the dashboard.
 */
const checkLink = (c: CiFailure["checks"][number]) => /^https:\/\//.test(c.url)
  ? `<a href="${escapeHtml(c.url)}">${escapeHtml(c.name)}</a>`
  : escapeHtml(c.name);

/** The failed checks of a CI failure, each linked to its run, as in "ci and e2e". */
const checkLinks = (f: CiFailure) => f.checks.length
  ? f.checks.map(checkLink).join(", ")
  : "no check the factory could read";

/** Floor's Stage cell for an item fixing CI (PBI 292): that it is, the checks that failed and the commit, in place of "green". */
const fixingCiStage = (f: CiFailure) => `fixing CI <span class="muted">${checkLinks(f)} failed on <code>${shortSha(f.sha)}</code></span>`;

/** Run detail's line for an item fixing CI (PBI 292): the commit and each failed check, with its URL and failing tests. */
function fixingCiSection(f: CiFailure): string {
  const items = f.checks.map((c) => `<li>${checkLink(c)}${c.url ? ` ${escapeHtml(c.url)}` : ""}${c.failingTests.length
    ? `<ul>${c.failingTests.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>`
    : ` <span class="muted">named no failing test</span>`}</li>`);
  return `<section id="fixing-ci" class="banner" role="status"><p>Fixing CI: Green is fixing the CI failure on commit <code>${shortSha(f.sha)}</code>. The checks that failed:</p>${
    items.length ? `<ul>${items.join("")}</ul>` : `<p class="muted">CI named no failed check the factory could read.</p>`}</section>`;
}

/** Floor's notice that the base fails in cells (PBI 215), naming each item blocked by it and the tests that fail. */
function baseFailsNotice(rows: BaseFailRow[]): string {
  const items = rows.map((r) => `<li>${named(r)} <span class="muted">at base commit ${escapeHtml(r.sha.slice(0, 7))}</span><ul>${r.tests.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul></li>`);
  return `<section id="base-fails" class="banner" role="status"><p>The base fails in cells. These items wait on it, since their Definition of Done or their CI fails the same tests on the base commit. Fix the base, then answer each item's question.</p><ul>${items.join("")}</ul></section>`;
}

/** Floor's notice that main is red (PBI 255), naming each commit that broke it, where it came from and its bug item. */
function mainRedNotice(rows: MainBreakRow[]): string {
  const branches = [...new Set(rows.map((r) => r.branch))].map((b) => `<code>${escapeHtml(b)}</code>`).join(" and ");
  const items = rows.map((r) => {
    const from = [r.pr_number !== null ? `PR #${r.pr_number}` : null, r.charged !== null ? `item ${issueRef(r.charged, r.repo)}` : null].filter(Boolean).join(" for ");
    const bug = r.bug_external_id === null
      ? "The factory is filing its bug item."
      : `Its bug item ${r.bug_id && r.bug_title ? named({ id: r.bug_id, title: r.bug_title, external_id: r.bug_external_id, repo: r.repo }) : issueRef(r.bug_external_id, r.repo)} ${r.bug_state === "Failed" ? `failed to make ${escapeHtml(r.branch)} pass, so ${escapeHtml(r.branch)} stays red until it's re-queued or someone fixes it` : "is claimed first"}.`;
    // A break with no item charged came from outside the factory, which files no bug item for it.
    if (r.charged === null) return `<li><code>${escapeHtml(r.branch)}</code> was already red at commit <code>${escapeHtml(r.sha.slice(0, 7))}</code>, which the factory didn't merge, so it filed no bug item. Someone needs to fix <code>${escapeHtml(r.branch)}</code>.</li>`;
    return `<li>Commit <code>${escapeHtml(r.sha.slice(0, 7))}</code> broke <code>${escapeHtml(r.branch)}</code>${from ? `, the merge of ${from}` : ""}. ${bug}</li>`;
  });
  const fixes = rows.some((r) => r.charged !== null) ? "The factory fixes it before it builds anything else, and an" : "An";
  return `<section id="main-red" class="banner" role="status"><p>${branches} is red. ${fixes} item merged onto it meanwhile waits for it to pass again.</p><ul>${items.join("")}</ul></section>`;
}

/**
 * A Cost cell, open for its closing tag: the cost to the cent through cost(), with the exact figure in its title so
 * hovering shows it. Floor (PBI 263) and Run detail (PBI 189) both use it.
 */
const costCell = (usd: string | number | null) => `<td title="${escapeHtml(`$${usd ?? 0}`)}">${escapeHtml(cost(usd))}`;

/** PBI 369: an item that failed its Definition of Done on main, on Floor, and when it was last re-checked, or null. */
export type FailedRow = Issue & { id: string; title: string; rechecked: Date | null };

/** When the factory last re-checked a Failed item (PBI 369), or that it hasn't yet. */
function recheckLine(at: Date | null, zone: string, sentence: boolean): string {
  const said = at ? `last re-checked at ${local(at, zone)}` : "not yet re-checked";
  if (!sentence) return `Failed, ${said}`;
  return at
    ? `Last re-checked at ${local(at, zone)}. The factory re-checks it every few hours and moves it back to Accepted once its merge no longer counts as breaking main.`
    : "It hasn't been re-checked yet. The factory re-checks it every few hours and moves it back to Accepted once its merge no longer counts as breaking main.";
}

export function floorPage(f: {
  active: ActiveRow[];
  waiting: WaitingRow[];
  waitingCount: number;
  capacity: number;
  next: (Issue & { id: string; title: string })[];
  notReady: NotReadyRow[];
  blocked?: BlockedRow[];
  factory: { kind: string; reason: string }[];
  canOperate: boolean;
  restart?: Restart | null;
  /** PBI 316: the cells still running, InProgress with a live lease, as Prepare restart counts them. */
  running?: number;
  cellImage?: CellImage | null;
  baseFails?: BaseFailRow[];
  mainBreaks?: MainBreakRow[];
  split?: SplitRow[];
  /** PBI 320: every item's claim key by id. */
  keys?: Map<string, ClaimKey>;
  /** PBI 320: every final-stage item, in claim order. */
  finalStage?: (Issue & { id: string; title: string; state: string })[];
  /** PBI 369: each item that went to Failed with dod_failed, and when it was last re-checked since, or null. */
  failed?: FailedRow[];
  /** The viewer's IANA time zone, from their browser's `tz` cookie. Defaults to UTC. */
  zone?: string;
}, banner: string | null): string {
  const st = (id: string) => standing(f.keys?.get(id));
  const list = (rows: string[], empty: string) => (rows.length ? `<ol>${rows.join("")}</ol>` : `<p class="muted">${empty}</p>`);
  const status = (f.mainBreaks?.length ? mainRedNotice(f.mainBreaks) : "")
    + f.factory.filter((o) => factoryState[o.kind]).map((o) => o.kind === "drain"
      ? drainStatus(o.reason, f.running)
      : `<p class="banner" role="status">${factoryState[o.kind]}: ${escapeHtml(o.reason)}</p>`).join("")
    + (f.restart ? restartStatus(f.restart) : "") + (f.cellImage ? cellImageStatus(f.cellImage) : "")
    + (f.baseFails?.length ? baseFailsNotice(f.baseFails) : "");
  const controls = f.canOperate
    ? `<h2>Controls</h2>${overrideForm([["pause", "Pause"], ["drain", "Drain"], ["resume", "Resume"], ["kill", "Kill switch"], ["restart", "Prepare restart"]], null)}`
    : "";
  return page("Floor", `<h1>Floor</h1>${status}
<p>${f.waitingCount} of ${f.capacity} waiting. <a href="/activity">Activity</a> <a href="/phase0">Phase 0 report</a> <a href="/configuration">Configuration</a></p>
<h2>Waiting on you</h2>
${list(f.waiting.map((w) => `<li>${named(w)}${withPr(w)} <span class="muted">${escapeHtml(w.state)}, waiting ${escapeHtml(age(w.since))}</span>${st(w.id)}</li>`), "Nothing waits on you.")}
<h2>Next up</h2>
${list(f.next.map((n) => `<li>${named(n)}${st(n.id)}</li>`), "Nothing is ready to start.")}
<h2>Final stage</h2>
${list((f.finalStage ?? []).map((n) => `<li>${named(n)} <span class="muted">${escapeHtml(n.state)}</span>${st(n.id)}</li>`), "No item is in the review loop, and none is depended on by one that is.")}
<h2>Not ready</h2>
${list(f.notReady.map((n) => `<li>${named(n)}${st(n.id)}<ul>${n.failed.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul></li>`), "Every item that entered is ready.")}
<h2>Blocked</h2>
${list((f.blocked ?? []).map((b) => `<li>${named(b)} <span class="muted">${escapeHtml(blockedReason(b.blocked_by))}</span>${st(b.id)}</li>`), "No ready item waits on another.")}
<h2>Split</h2>
${list((f.split ?? []).map((p) => `<li>${named(p)} <span class="muted">Split into</span>${splitInto(p.children)}</li>`), "No item is split into children that are still open.")}
<h2>Failed on main</h2>
${list((f.failed ?? []).map((n) => `<li>${named(n)} <span class="muted">${recheckLine(n.rechecked, f.zone ?? "UTC", false)}</span></li>`), "No item failed its Definition of Done on main.")}
<h2>In flight</h2>
${f.active.length ? `<table><thead><tr><th scope="col">Item</th><th scope="col">State</th><th scope="col">Stage</th><th scope="col">In stage</th><th scope="col">Cost</th><th scope="col">Last agent message</th></tr></thead><tbody>
${f.active.map((a) => `<tr><td>${named(a)}${withPr(a)} ${a.badges.map((b) => `<span class="badge">${escapeHtml(b)}</span>`).join(" ")}${st(a.id)}</td><td>${escapeHtml(a.state)}</td><td>${a.ci_failure ? fixingCiStage(a.ci_failure) : escapeHtml(a.stage ?? "")}</td><td>${escapeHtml(age(a.since))}</td>${costCell(a.cost)}</td><td class="muted">${escapeHtml(a.message ?? "")}</td></tr>`).join("\n")}
</tbody></table>` : `<p class="muted">No item is in flight.</p>`}
${controls}
<script>
// Floor updates live from the event log: reload a second after the last event, so a burst reloads once. While an
// operator is filling in a form, it waits, so a half-typed reason isn't lost.
const busy = () => document.activeElement?.form || [...document.querySelectorAll("form input:not([type=hidden])")].some((i) => i.value);
let reload; const later = () => { clearTimeout(reload); reload = setTimeout(() => (busy() ? later() : location.reload()), 1000); };
new EventSource("/events").onmessage = later;
</script>`, banner);
}

/** A @regression scenario is exempt from failing at Red, so the sign-off view says so. */
export type Scenario = { name: string; regression: boolean };

export type RunDetail = {
  item: Issue & { id: string; title: string; state: string };
  run: { sop_version: string | null; config_sha: string | null; scenarios_sha: string | null; features_lock_sha: string | null; risk_tier: string | null; tier_reasons: string[] | null; next_stage: string | null;
    /** The run's PR, and whether the run is still open: only an open run's PR shows (PBI 145). */
    pr_number?: number | null; pr_url?: string | null; open?: boolean } | null;
  policies: { file: string; source: string; criterion: string; status: string; reason: string | null }[];
  stages: { stage_id: string; attempt: number; model: string | null;
    /** The effort the attempt ran at, null on a row from before PBI 319, which ran at medium. */
    effort?: string | null; tokens_in: number | null; tokens_out: number | null; cost_usd: string | null; status: string; transcript_ref: string | null;
    /** When the attempt started and ended, null while it still runs (PBI 189). */
    started_at?: Date; ended_at?: Date | null;
    /** PBI 190: the PR reviewer's restates in the attempt. */
    restates?: { round: number; reason: string }[];
    /** What the attempt's cell, or the factory closing it, said about it, such as that the cell's lease ran out (PBI 239). */
    message?: string | null }[];
  /** Every readiness judge and split call on the item, oldest first, a failed one's included (PBI 132). */
  readiness: (Omit<StoredReadinessCheck, "effort"> & { effort?: string | null })[];
  question: { kind: string; body: string } | null;
  criteria: { criterion: string; scenarios: Scenario[] }[] | null;
  /** The issue's body as written on GitHub, shown at sign-off, or null when it's blank or no form shows. */
  scope: string | null;
  /** The feature files up for sign-off, at the scenarios sha, while the sign-off form shows. */
  pending: { path: string; text: string }[];
  /** The signed-off feature files at the lock sha. */
  features: { path: string; text: string }[];
  /** The item's scenarios with their verdicts in the latest red and green reports. */
  verdicts: { name: string; red: string; green: string }[];
  /** True when the stored transcripts can be served, so each one is a link. */
  linkBlobs: boolean;
  /** PBI 292: the CI failure the item is fixing at Green, or null when it fixes none. */
  fixingCi?: CiFailure | null;
  /** An operator's override buttons for this item, or null for anyone else. */
  controls: { held: boolean; stoppable: boolean; requeueable: boolean; startable?: boolean; movable?: boolean } | null;
  /** The item's active Start now override (PBI 265), with its reason and who set it, or null when it has none. */
  startNow?: { reason: string; by: string | null } | null;
  /** PBI 311: the item's latest Move up or Move down, when a change to the board's order ended it, or null. */
  moveEnded?: { control: "Move up" | "Move down"; at: Date } | null;
  /** The item's claim key (PBI 320): its priority and whether it's final-stage, and the items they come from. */
  claim?: ClaimKey | null;
  /** The viewer's IANA time zone, from their browser's `tz` cookie (PBI 189). Defaults to UTC. */
  zone?: string;
  /** The time now, for how long a running attempt has taken so far (PBI 189). Defaults to the real time. */
  now?: Date;
  /** Where the item's time went (PBI 187). Without it, the Time section is left out. */
  durations?: ItemDurations;
  /** The children a Split parent's split filed, in order (PBI 227). Without any, no "Split into" shows. */
  splitInto?: SplitChildView[];
  /** PBI 369: for an item that failed its Definition of Done on main, when it was last re-checked, or null. */
  recheck?: { last: Date | null } | null;
  /**
   * PBI 395: the rule changes the item's last readiness check read, whether it waits for the owner's approval of them,
   * whether this viewer may give it, and the owner's approval of them as they read now. Null when it read none.
   */
  ruleChanges?: { changes: RuleChangeRead[]; waiting: boolean; canApprove: boolean; approval: { by: string; at: Date } | null } | null;
  /** PBI 364: the feature change request the item waits on in FeatureChangeRequest. Without one, no such section shows. */
  featureChange?: FeatureChangeFile[] | null;
  /** PBI 365: true when the viewer is a product owner, who alone gets Approve the change and Ask for changes. */
  canDecideFeatureChange?: boolean;
  /** PBI 365: the latest decision on a feature change request of the item, shown once no request is open. */
  featureChangeDecision?: { kind: "approve" | "changes"; by: string; at: Date } | null;
};

const marked = (words: DiffWord[]) => words.map((w) => (w.changed ? `<mark>${escapeHtml(w.text)}</mark>` : escapeHtml(w.text))).join(" ");

/**
 * The item page's Feature change request section (PBI 364), as sign-off shows scenarios: each file under its path, the
 * stage's reason, then its change from the lock commit, each line taken out and put in marked by its side.
 */
function featureChangeSection(files: FeatureChangeFile[], id: string, canDecide: boolean): string {
  const line = (l: DiffLine | null) => l === null
    ? `<span class="muted">…</span>`
    : l.side === "before" ? `<del data-side="before">${escapeHtml(l.text)}</del>`
      : l.side === "after" ? `<ins data-side="after">${escapeHtml(l.text)}</ins>`
        : `<span data-side="same">${escapeHtml(l.text)}</span>`;
  const entries = files.map((f) => `<h3>${escapeHtml(f.path)}</h3><p data-reason>${escapeHtml(f.reason)}</p><pre class="diff">${lineDiff(f.before, f.after).map(line).join("\n")}</pre>`);
  return `<h2>Feature change request</h2><p>A stage after sign-off asks to change ${files.length === 1 ? "this locked feature file" : "these locked feature files"}. The branch keeps ${files.length === 1 ? "it" : "them"} as at the lock commit, and the item waits on the owner.</p>${entries.join("")}${canDecide ? featureChangeForm(id) : ""}`;
}

/**
 * PBI 365: the Product Owner's decision on a feature change request, after the changes it would make, as at sign-off.
 * Approve commits the proposed files and locks them there, and Ask for changes keeps the lock and sends the note to
 * the stage that asked.
 */
function featureChangeForm(id: string): string {
  return `<form method="post" action="/items/${escapeHtml(id)}/feature-change"><label for="feature-change-note">Note for the factory</label><textarea id="feature-change-note" name="note"></textarea>
<p><button name="decision" value="approve">Approve the change</button> <button name="decision" value="changes">Ask for changes</button></p></form>`;
}

/** PBI 365: who approved or turned down the item's last feature change request, and when. */
function featureChangeDecisionLine(d: NonNullable<RunDetail["featureChangeDecision"]>, zone: string): string {
  return `<p id="feature-change-decision">${escapeHtml(d.by)} ${d.kind === "approve" ? "approved" : "turned down"} the feature change request at ${local(d.at, zone)}.</p>`;
}

/** The item page's Rule changes section (PBI 395): each rule's Before beside its After, the words that change marked. */
function ruleChangesSection(id: string, r: NonNullable<RunDetail["ruleChanges"]>, zone: string): string {
  const entries = r.changes.map((c) => {
    const diff = c.before !== null && c.after !== null ? wordDiff(c.before, c.after) : null;
    const side = (which: "before" | "after", label: string, text: string | null, words: DiffWord[] | undefined) => text === null
      ? `<div><h4>${label}</h4><p class="muted">No ${label} given.</p></div>`
      : `<div><h4>${label}</h4><blockquote data-side="${which}">${words ? marked(words) : escapeHtml(text)}</blockquote></div>`;
    return `<div class="rule" data-rule="${escapeHtml(placeKey(c.place))}"><h3>${c.place.kind === "spec" ? `Spec ${escapeHtml(c.place.section)}` : escapeHtml(c.place.path)}</h3>
${c.problem ? `<p class="banner">${escapeHtml(c.problem)}</p>` : ""}<div class="sides">${side("before", "Before", c.before, diff?.before)}${side("after", "After", c.after, diff?.after)}</div></div>`;
  }).join("\n");
  const all = r.changes.map((c) => placeName(c.place));
  const list = all.length <= 1 ? all.join("") : `${all.slice(0, -1).join(", ")} and ${all.at(-1)}`;
  const status = r.approval
    ? `<p>${escapeHtml(r.approval.by)} approved the rule change at ${local(r.approval.at, zone)}.</p>`
    : r.waiting
      ? `<p>This item waits for the owner to approve its rule changes: ${escapeHtml(list)}.</p>`
      : "";
  const form = r.canApprove
    ? `<form method="post" action="/items/${escapeHtml(id)}/rule-approval"><input type="hidden" name="ruleChangesHash" value="${escapeHtml(ruleChangesHash(r.changes))}"><p><button>Approve rule change</button></p></form>`
    : "";
  return `<h2>Rule changes</h2>${status}\n${entries}\n${form}`;
}

/**
 * Sets the `tz` cookie to the browser's time zone, so the server shows times in it, and reloads once when the page
 * came in another zone (PBI 189). A browser that can't tell its zone, or that drops the cookie, keeps the page as it is.
 */
const zoneScript = (zone: string) => `<script>
(() => {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!tz) return;
  const sent = "tz=" + encodeURIComponent(tz);
  // A cookie already holding this zone means the server had it, so a page in another zone never reloads in a loop.
  const had = document.cookie.split("; ").includes(sent);
  document.cookie = sent + "; path=/; max-age=31536000; samesite=lax";
  // Reload only if the cookie stuck: a browser that blocks cookies would never send it, and would reload forever.
  const stuck = document.cookie.split("; ").includes(sent);
  if (!had && stuck && tz !== ${JSON.stringify(zone).replace(/</g, "\\u003c")}) location.reload();
})();
</script>`;

/** Run detail's Time section: the total, the time Queued, each wait on a person and their total, and each stage's time. */
function timeSection(t: ItemDurations): string {
  const figure = (label: string, ms: number | null) => `<dt>${label}</dt><dd>${ms === null ? "not known yet" : formatDuration(ms)}</dd>`;
  const w = t.waiting;
  const stages = t.stages.length
    ? `<table><thead><tr><th scope="col">Stage</th><th scope="col">Time</th><th scope="col">Attempts</th></tr></thead><tbody>${t.stages
        .map((s) => `<tr><td>${escapeHtml(s.stageId)}</td><td>${formatDuration(s.ms)}</td><td>${s.attempts}</td></tr>`).join("")}</tbody></table>`
    : `<p class="muted">No stage has run yet.</p>`;
  return `<h2>Time</h2><dl>${figure("Total", t.totalMs)}${figure("Queued", t.queuedMs)}</dl>
<h3>Waiting on a person</h3><dl>${figure("Sign-off", w.signOffMs)}${figure("Needs input", w.needsInputMs)}${figure("In review", w.inReviewMs)}${figure("Waiting on a person", w.totalMs)}</dl>
<h3>Time in each stage</h3>${stages}`;
}

export function runDetailPage(d: RunDetail, banner: string | null): string {
  const r = d.run;
  const zone = d.zone ?? "UTC";
  const now = d.now ?? new Date();
  const started = (s: RunDetail["stages"][number]) => (s.started_at ? local(s.started_at, zone) : "");
  // An attempt with no end is running only while the item is In progress on an open run, and only if it's the run's
  // newest attempt: a cell that died mid-stage leaves its row open until its lease runs out and the factory closes it
  // (PBI 239), and a row left open anyway must never count against now, or its time would climb for ever.
  const newest = d.stages.reduce<RunDetail["stages"][number] | null>(
    (a, s) => (s.started_at && (!a?.started_at || s.started_at.getTime() >= a.started_at.getTime()) ? s : a), null);
  const live = (s: RunDetail["stages"][number]) => d.item.state === "InProgress" && d.run?.open === true && s === newest;
  const took = (s: RunDetail["stages"][number]) =>
    !s.started_at ? "" : s.ended_at ? timeSpent(s.started_at, s.ended_at) : live(s) ? `${timeSpent(s.started_at, now)} so far` : "didn't finish";
  // An attempt's notes: its message, then each time the PR reviewer needed a second ask (PBI 190, PBI 239).
  const notes = (s: RunDetail["stages"][number]) => [
    ...(s.message ? [escapeHtml(s.message)] : []),
    ...(s.restates ?? []).map((x) => `Needed a second ask of the PR reviewer in round ${escapeHtml(x.round)}: ${escapeHtml(x.reason)}`),
  ].join("<br>");
  // PBI 209: an attempt with no end says it's running while it's live, and stopped once its cell is gone, so a stage
  // whose cell died reads as stopped beside the transcript it last uploaded.
  const status = (s: RunDetail["stages"][number]) => (s.status !== "started" || s.ended_at ? s.status : live(s) ? "running" : "stopped");
  // Each Tokens cell, like each Cost cell, keeps the exact figures in its title, so hovering shows them in full.
  const exactTokens = (tokensIn: number | null, tokensOut: number | null) => `<td title="${escapeHtml(`${tokensIn ?? 0} in, ${tokensOut ?? 0} out`)}">`;
  const policies = d.policies.length
    ? `<table><thead><tr><th scope="col">File</th><th scope="col">Criterion</th><th scope="col">Result</th><th scope="col">Reason</th></tr></thead><tbody>${d.policies
        .map((p) => `<tr><td>${escapeHtml(p.file)}.md <span class="muted">${escapeHtml(p.source)}</span></td><td>${escapeHtml(p.criterion)}</td><td>${escapeHtml(p.status)}</td><td>${escapeHtml(p.reason ?? "")}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="muted">No policy results yet.</p>`;
  const stages = d.stages.length
    ? `<table><thead><tr><th scope="col">Stage</th><th scope="col">Attempt</th><th scope="col">Status</th><th scope="col">Model</th><th scope="col">Started</th><th scope="col">Time spent</th><th scope="col">Tokens</th><th scope="col">Cost</th><th scope="col">Transcript</th><th scope="col">Notes</th></tr></thead><tbody>${d.stages
        .map((s) => `<tr><td>${escapeHtml(s.stage_id)}</td><td>${escapeHtml(s.attempt)}</td><td>${escapeHtml(status(s))}</td><td>${escapeHtml(s.model ? withEffort(s.model, s.effort) : "model not recorded")}</td><td>${started(s)}</td><td>${escapeHtml(took(s))}</td>${exactTokens(s.tokens_in, s.tokens_out)}${escapeHtml(tokens(s.tokens_in ?? 0))} in, ${escapeHtml(tokens(s.tokens_out ?? 0))} out</td>${costCell(s.cost_usd)}</td><td>${!s.transcript_ref ? "" : d.linkBlobs ? `<a href="/blobs/${escapeHtml(s.transcript_ref)}">transcript</a>` : escapeHtml(s.transcript_ref)}</td><td>${notes(s)}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="muted">No stage has run yet.</p>`;
  const readiness = d.readiness.length
    ? `<table><thead><tr><th scope="col">Ran</th><th scope="col">Call</th><th scope="col">Model</th><th scope="col">Tokens</th><th scope="col">Cost</th><th scope="col">Verdict</th></tr></thead><tbody>${d.readiness
        .map((c) => `<tr><td>${local(c.ranAt, zone)}</td><td>${c.kind === "split" ? "Split proposal" : "Judge"}</td><td>${escapeHtml(withEffort(c.model, c.effort))}</td>${exactTokens(c.tokensIn, c.tokensOut)}${escapeHtml(tokens(c.tokensIn))} in, ${escapeHtml(tokens(c.tokensOut))} out</td>${costCell(c.costUsd)}</td><td>${checkVerdict(c)}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="muted">No readiness check has run yet.</p>`;
  const criteria = d.criteria
    ? `<h2>Criteria and their scenarios</h2><ol>${d.criteria
        .map((c) => `<li>${escapeHtml(c.criterion)}${c.scenarios.length ? `<ul>${c.scenarios.map((s) => `<li>${escapeHtml(s.name)}${s.regression ? ` <strong>expected to pass at Red</strong>` : ""}</li>`).join("")}</ul>` : ` <strong>no scenario</strong>`}</li>`)
        .join("")}</ol>`
    : "";
  const files = (fs: { path: string; text: string }[]) => fs.map((f) => `<h3>${escapeHtml(f.path)}</h3><pre>${escapeHtml(f.text)}</pre>`).join("");
  // The owner reads what the item is for, the criteria and the scenarios in full before reaching the buttons.
  const scope = d.scope ? `<h2>Scope</h2><pre class="scope">${escapeHtml(d.scope)}</pre>` : "";
  const pending = d.pending.length ? `<h2>Scenarios up for sign-off</h2>${files(d.pending)}` : "";
  const id = escapeHtml(d.item.id);
  const form = d.question?.kind === "sign_off"
    ? `<h2>Sign off</h2><form method="post" action="/items/${id}/signoff"><label for="note">Note for the factory</label><textarea id="note" name="note"></textarea>
<p><button name="decision" value="approve">Approve the scenarios</button> <button name="decision" value="changes">Ask for changes</button></p></form>`
    : d.question?.kind === "needs_input"
      ? `<h2>Answer</h2><p>${escapeHtml(d.question.body)}</p><form method="post" action="/items/${id}/answer"><label for="answer">Your answer</label><textarea id="answer" name="answer" required></textarea><p><button>Send the answer</button></p></form>`
      : "";
  const verdicts = d.verdicts.length
    ? `<h2>Scenarios at red and green</h2><table><thead><tr><th scope="col">Scenario</th><th scope="col">Red</th><th scope="col">Green</th></tr></thead><tbody>${d.verdicts
        .map((v) => `<tr><td>${escapeHtml(v.name)}</td><td>${escapeHtml(v.red)}</td><td>${escapeHtml(v.green)}</td></tr>`).join("")}</tbody></table>`
    : "";
  const c = d.controls;
  const controls = c
    ? `<h2>Controls</h2>${overrideForm([
        ...(c.held ? [["unhold", "Release the hold"]] : [["hold", "Hold"]]),
        ...(c.stoppable ? [["stop_run", "Stop the run"]] : []),
        ...(c.requeueable ? [["requeue", "Re-queue"]] : []),
        ...(c.startable ? [["start_now", "Start now"]] : []),
        ...(c.movable ? [["move_up", "Move up"], ["move_down", "Move down"]] : []),
      ] as [string, string][], d.item.id)}`
    : "";
  return page(d.item.title, `<h1>${issueRef(d.item.external_id, d.item.repo)} ${escapeHtml(d.item.title)}</h1>
<p>${escapeHtml(d.item.state)}${r?.open ? withPr({ ...r, state: d.item.state }) : ""}${r?.next_stage ? `, resumes at ${escapeHtml(r.next_stage)}` : ""}</p>
${d.recheck ? `<p id="recheck">${recheckLine(d.recheck.last, zone, true)}</p>\n` : ""}${d.splitInto?.length ? `<h2>Split into</h2>${splitInto(d.splitInto)}` : ""}
${d.claim ? `${claimLines(d.claim)}\n` : ""}${d.startNow ? `<p>Marked Start now: ${escapeHtml(d.startNow.reason)}${d.startNow.by ? `, by ${escapeHtml(d.startNow.by)}` : ""}. The next free slot claims it first once it's Queued, not held and not blocked.</p>\n` : ""}${d.moveEnded ? `<p>${d.moveEnded.control} ended by a change to the board's order, at ${local(d.moveEnded.at, zone)}: the board now puts the item and the item it passed the other way round from when it was moved, so it follows the board again.</p>\n` : ""}${d.fixingCi ? fixingCiSection(d.fixingCi) : ""}<dl><dt>SOP version</dt><dd>${escapeHtml(r?.sop_version ?? "not pinned yet")}</dd><dt>Config</dt><dd>${escapeHtml(r?.config_sha ?? "not pinned yet")}</dd>
<dt>Scenarios locked at</dt><dd>${escapeHtml(r?.features_lock_sha ?? "not signed off")}</dd>
<dt>Shadow risk tier</dt><dd>${escapeHtml(r?.risk_tier ?? "not classified")}${r?.tier_reasons?.length ? `<ul>${r.tier_reasons.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>` : ""}</dd></dl>
${d.ruleChanges ? ruleChangesSection(d.item.id, d.ruleChanges, zone) : ""}${d.featureChange?.length ? featureChangeSection(d.featureChange, d.item.id, d.canDecideFeatureChange === true) : d.featureChangeDecision ? featureChangeDecisionLine(d.featureChangeDecision, zone) : ""}${scope}${criteria}${pending}${form}${controls}${verdicts}${d.durations ? timeSection(d.durations) : ""}<h2>Policy results</h2>${policies}<h2>Stages</h2><p class="muted">Times show in ${escapeHtml(zone)}.</p>${stages}<h2>Readiness checks</h2>${readiness}${
    d.features.length ? `<h2>Signed-off scenarios</h2>${files(d.features)}` : ""
  }${zoneScript(zone)}`, banner);
}

export type Phase0Row = Issue & { item_id: string; title: string; pr_url: string | null; merged_at: Date | null; cost: number; risk_tier: string | null; tier_reasons: string[] | null };

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Spec §13's Phase 0 exit report for this database. The runbook adds the local and Azure figures together. Stage spend
 * is the merged runs' stages. Readiness spend is every readiness check on every item, so the items the gate turned
 * away count too (PBI 132).
 */
export function phase0Page(rows: Phase0Row[], readinessSpend: number, banner: string | null): string {
  const total = rows.reduce((sum, r) => sum + r.cost, 0);
  const summary = `${rows.length} merged PR${rows.length === 1 ? "" : "s"}, ${usd(total)} in all, ${rows.length ? usd(total / rows.length) : "$0.00"} each on average.`;
  const spend = `<dl><dt>Stage spend</dt><dd>${usd(total)}</dd><dt>Readiness spend</dt><dd>${judgeUsd(readinessSpend)}</dd></dl>`;
  const table = rows.length
    ? `<table><thead><tr><th scope="col">Item</th><th scope="col">PR</th><th scope="col">Merged</th><th scope="col">Cost</th><th scope="col">Shadow tier</th></tr></thead><tbody>${rows
        .map((r) => `<tr><td>${named({ ...r, id: r.item_id })}</td><td>${r.pr_url ? `<a href="${escapeHtml(r.pr_url)}">${escapeHtml(r.pr_url)}</a>` : ""}</td><td>${escapeHtml(r.merged_at?.toISOString().slice(0, 10) ?? "")}</td><td>${usd(r.cost)}</td><td>${escapeHtml(r.risk_tier ?? "not classified")}${r.tier_reasons?.length ? `<ul>${r.tier_reasons.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>` : ""}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="muted">No factory PR has merged yet.</p>`;
  return page("Phase 0 report", `<h1>Phase 0 report</h1><p>${summary}</p>${spend}${table}`, banner);
}

/** One event as the activity log reads it: only `from`, `to` and `event` come out of the payload, and a setting change's own fields. */
export type ActivityRow = { at: Date; external_id: string | null; repo: string | null; title: string | null; kind: string; from: string | null; to: string | null; event: string | null;
  /** Who made a `setting` change, the setting's name (PBI 175), and why (PBI 176). */
  actor?: string | null; setting?: string | null; reason?: string | null };

// Only a move between states shows where the item came from and went. Another kind's from and to stay off the page.
// An SOP move (PBI 173) shows its old and new versions where a transition shows its states.
export const MOVES = new Set(["transition", "override", "sop_moved"]);

/** The factory's newest events, newest first, with the time in UTC (PBI 105). */
export function activityPage(rows: ActivityRow[], banner: string | null): string {
  const cell = (r: ActivityRow) => {
    if (r.kind === "setting") {
      const why = r.reason ? ` because ${escapeHtml(r.reason)}` : "";
      return `<td>${escapeHtml(r.actor ?? "")} changed ${escapeHtml(r.setting ?? "")} from ${escapeHtml(r.from ?? "not set")} to ${escapeHtml(r.to ?? "not set")}${why}</td>`;
    }
    if (!MOVES.has(r.kind)) return "<td></td>";
    const event = r.kind === "transition" && r.event ? ` <span class="muted">(${escapeHtml(r.event)})</span>` : "";
    return `<td>${escapeHtml(r.from ?? "")} → ${escapeHtml(r.to ?? "")}${event}</td>`;
  };
  const table = rows.length
    ? `<table><thead><tr><th scope="col">Time (UTC)</th><th scope="col">Item</th><th scope="col">Title</th><th scope="col">Kind</th><th scope="col">Move</th></tr></thead><tbody>${rows
        .map((r) => `<tr><td>${utc(r.at)}</td><td>${issueRef(r.external_id, r.repo)}</td><td>${escapeHtml(r.title)}</td><td>${escapeHtml(r.kind)}</td>${cell(r)}</tr>`)
        .join("")}</tbody></table>`
    : `<p class="muted">No event yet.</p>`;
  return page("Activity", `<h1>Activity</h1><p class="muted">The 100 newest events, newest first.</p>${table}`, banner);
}

/** One setting as the Configuration page lists it: its key, its name, and its value, or null when it has none. */
export type ConfigSetting = { key: string; label: string; value: string | null; editable?: boolean; clearable?: boolean; note?: string };

/**
 * The Configuration page (PBI 175). Runtime settings come first. An operator gets a form beside each one they can
 * change, which asks for the change's reason too (PBI 176), and a viewer gets none. An operator also gets a button to clear an active usage pause (PBI 178). Env-backed settings are read-only, and each says it needs a restart.
 */
export function configurationPage(c: { runtime: ConfigSetting[]; env: ConfigSetting[]; canOperate: boolean; notice?: string | null; error?: string | null; now?: Date }, banner: string | null): string {
  const at = c.now ?? new Date();
  const value = (v: string | null) => (v === null ? `<span class="muted">not set</span>` : escapeHtml(v));
  const note = (s: ConfigSetting) => (s.note ? `<span class="muted">${escapeHtml(s.note)}</span>` : "");
  const change = (s: ConfigSetting) => {
    if (s.clearable && c.canOperate && pauseActive(s.value, at)) {
      // PBI 178: an operator can clear an active usage pause, with a reason, but never set one. A pause whose time
      // has passed is no pause, so it gets no button.
      return `<td><form method="post" action="/configuration"><input type="hidden" name="setting" value="${escapeHtml(s.key)}"><input type="hidden" name="value" value="">
<label for="reason-${escapeHtml(s.key)}">Reason</label><input id="reason-${escapeHtml(s.key)}" name="reason" required> <button>Clear</button></form>${note(s)}</td>`;
    }
    if (!s.editable) return `<td class="muted">Set by the factory</td>`;
    if (!c.canOperate) return `<td>${note(s)}</td>`;
    const id = `setting-${escapeHtml(s.key)}`;
    return `<td><form method="post" action="/configuration"><input type="hidden" name="setting" value="${escapeHtml(s.key)}">
<label for="${id}">New ${escapeHtml(s.label)}</label><input id="${id}" name="value" value="${escapeHtml(s.value ?? "")}">
<label for="reason-${escapeHtml(s.key)}">Reason</label><input id="reason-${escapeHtml(s.key)}" name="reason" required> <button>Change</button></form>${note(s)}</td>`;
  };
  const head = (third: string) => `<thead><tr><th scope="col">Setting</th><th scope="col">Value</th><th scope="col">${third}</th></tr></thead>`;
  const runtime = `<table>${head(c.canOperate ? "Change" : "Notes")}<tbody>${c.runtime
    .map((s) => `<tr><th scope="row">${escapeHtml(s.label)}</th><td>${value(s.value)}</td>${change(s)}</tr>`).join("")}</tbody></table>`;
  const env = `<table>${head("Takes effect")}<tbody>${c.env
    .map((s) => `<tr><th scope="row"><code>${escapeHtml(s.label)}</code></th><td>${value(s.value)}</td><td>Needs a restart</td></tr>`).join("")}</tbody></table>`;
  const notice = c.notice ? `<p class="banner" role="status">${escapeHtml(c.notice)}</p>` : "";
  const error = c.error ? `<p class="banner" role="alert">${escapeHtml(c.error)}</p>` : "";
  return page("Configuration", `<h1>Configuration</h1>${notice}${error}
<h2>Runtime settings</h2><p class="muted">The factory's WIP policy, as it is now. A change takes effect on the scheduler's next turn, with no restart, unless its note says it does less.</p>${runtime}
<h2>Env-backed settings</h2><p class="muted">What the control plane read from its environment at start. A change takes effect only when the factory restarts. Secrets never show here.</p>${env}`, banner);
}
