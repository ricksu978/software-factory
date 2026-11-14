// Dashboard HTML (plan Task 15). Every value goes through escapeHtml, and colours are custom properties with a
// dark-mode override.
import { formatDuration, type ItemDurations } from "../core/durations.ts";
import { pauseActive } from "./configuration.ts";
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

export type ActiveRow = Issue & OpenPr & { id: string; title: string; state: string; stage: string | null; since: Date | null; cost: string; badges: string[]; message: string | null };
export type WaitingRow = Issue & OpenPr & { id: string; title: string; state: string; since: Date | null };
export type NotReadyRow = Issue & { id: string; title: string; failed: string[] };
/** A Queued item held back by its open dependencies, as the issue numbers GitHub lists as blocking it (PBI 237). */
export type BlockedRow = Issue & { id: string; title: string; blocked_by: string[] };
/** An item waiting on a question that blames the base (PBI 215): the base commit and the tests that fail on it. */
export type BaseFailRow = Issue & { id: string; title: string; sha: string; tests: string[] };

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
  return repo && /^\d+$/.test(externalId) ? `<a href="https://github.com/${escapeHtml(repo)}/issues/${externalId}">${text}</a>` : text;
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

/** A form posting one override to /overrides. The reason is required, so the browser asks for it first. */
function overrideForm(kinds: [kind: string, label: string][], itemId: string | null): string {
  const id = itemId ? `-${escapeHtml(itemId)}` : "";
  return `<form method="post" action="/overrides">${itemId ? `<input type="hidden" name="itemId" value="${escapeHtml(itemId)}">` : ""}
<label for="reason${id}">Reason</label><input id="reason${id}" name="reason" required>
<p>${kinds.map(([k, label]) => `<button name="kind" value="${k}">${label}</button>`).join(" ")}</p></form>`;
}

const factoryState: Record<string, string> = { pause: "Paused", drain: "Draining", kill: "Killed" };

/** A restart being prepared (PBI 140): the minutes left in its wrap-up and how many cells still run. */
export type Restart = { minutesLeft: number; running: number; reason?: string };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Floor's line for a restart being prepared: a countdown while a cell still runs, then that it's safe to restart. */
function restartStatus(r: Restart): string {
  const why = r.reason ? ` Reason: ${escapeHtml(r.reason)}.` : "";
  const text = r.running > 0
    ? `Preparing to restart: ${plural(r.running, "cell is", "cells are")} wrapping up, with ${plural(r.minutesLeft, "minute", "minutes")} left before the factory stops ${r.running === 1 ? "it" : "them"}.`
    : "Ready to restart. No cell is running, so it's safe to restart the factory or stop Docker.";
  return `<p class="banner" role="status">${escapeHtml(text)}${why}</p>`;
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

/** Floor's notice that the base fails in cells (PBI 215), naming each item blocked by it and the tests that fail. */
function baseFailsNotice(rows: BaseFailRow[]): string {
  const items = rows.map((r) => `<li>${named(r)} <span class="muted">at base commit ${escapeHtml(r.sha.slice(0, 7))}</span><ul>${r.tests.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul></li>`);
  return `<section id="base-fails" class="banner" role="status"><p>The base fails in cells. These items wait on it, since their Definition of Done fails the same tests on the base commit. Fix the base, then answer each item's question.</p><ul>${items.join("")}</ul></section>`;
}

export function floorPage(f: { active: ActiveRow[]; waiting: WaitingRow[]; waitingCount: number; capacity: number; next: (Issue & { id: string; title: string })[];
  notReady: NotReadyRow[]; blocked?: BlockedRow[]; factory: { kind: string; reason: string }[]; canOperate: boolean; restart?: Restart | null; baseFails?: BaseFailRow[] }, banner: string | null): string {
  const list = (rows: string[], empty: string) => (rows.length ? `<ol>${rows.join("")}</ol>` : `<p class="muted">${empty}</p>`);
  const status = f.factory.filter((o) => factoryState[o.kind]).map((o) => `<p class="banner" role="status">${factoryState[o.kind]}: ${escapeHtml(o.reason)}</p>`).join("")
    + (f.restart ? restartStatus(f.restart) : "")
    + (f.baseFails?.length ? baseFailsNotice(f.baseFails) : "");
  const controls = f.canOperate
    ? `<h2>Controls</h2>${overrideForm([["pause", "Pause"], ["drain", "Drain"], ["resume", "Resume"], ["kill", "Kill switch"], ["restart", "Prepare restart"]], null)}`
    : "";
  return page("Floor", `<h1>Floor</h1>${status}
<p>${f.waitingCount} of ${f.capacity} waiting. <a href="/activity">Activity</a> <a href="/phase0">Phase 0 report</a> <a href="/configuration">Configuration</a></p>
<h2>Waiting on you</h2>
${list(f.waiting.map((w) => `<li>${named(w)}${withPr(w)} <span class="muted">${escapeHtml(w.state)}, waiting ${escapeHtml(age(w.since))}</span></li>`), "Nothing waits on you.")}
<h2>Next up</h2>
${list(f.next.map((n) => `<li>${named(n)}</li>`), "Nothing is ready to start.")}
<h2>Not ready</h2>
${list(f.notReady.map((n) => `<li>${named(n)}<ul>${n.failed.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul></li>`), "Every item that entered is ready.")}
<h2>Blocked</h2>
${list((f.blocked ?? []).map((b) => `<li>${named(b)} <span class="muted">${escapeHtml(blockedReason(b.blocked_by))}</span></li>`), "No ready item waits on another.")}
<h2>In flight</h2>
${f.active.length ? `<table><thead><tr><th scope="col">Item</th><th scope="col">State</th><th scope="col">Stage</th><th scope="col">In stage</th><th scope="col">Cost</th><th scope="col">Last agent message</th></tr></thead><tbody>
${f.active.map((a) => `<tr><td>${named(a)}${withPr(a)} ${a.badges.map((b) => `<span class="badge">${escapeHtml(b)}</span>`).join(" ")}</td><td>${escapeHtml(a.state)}</td><td>${escapeHtml(a.stage ?? "")}</td><td>${escapeHtml(age(a.since))}</td><td>$${escapeHtml(a.cost)}</td><td class="muted">${escapeHtml(a.message ?? "")}</td></tr>`).join("\n")}
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
  stages: { stage_id: string; attempt: number; model: string | null; tokens_in: number | null; tokens_out: number | null; cost_usd: string | null; status: string; transcript_ref: string | null;
    /** When the attempt started and ended, null while it still runs (PBI 189). */
    started_at?: Date; ended_at?: Date | null;
    /** PBI 190: the PR reviewer's restates in the attempt. */
    restates?: { round: number; reason: string }[] }[];
  /** Every readiness judge and split call on the item, oldest first, a failed one's included (PBI 132). */
  readiness: { kind?: "judge" | "split"; model: string; tokensIn: number; tokensOut: number; costUsd: number; ranAt: Date }[];
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
  /** An operator's override buttons for this item, or null for anyone else. */
  controls: { held: boolean; stoppable: boolean; requeueable: boolean } | null;
  /** The viewer's IANA time zone, from their browser's `tz` cookie (PBI 189). Defaults to UTC. */
  zone?: string;
  /** The time now, for how long a running attempt has taken so far (PBI 189). Defaults to the real time. */
  now?: Date;
  /** Where the item's time went (PBI 187). Without it, the Time section is left out. */
  durations?: ItemDurations;
};

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
  // newest attempt: a cell that died mid-stage leaves its row open for good, and a new claim on the same run numbers
  // its attempts after it, so counting that dead row against now would climb for ever.
  const newest = d.stages.reduce<RunDetail["stages"][number] | null>(
    (a, s) => (s.started_at && (!a?.started_at || s.started_at.getTime() >= a.started_at.getTime()) ? s : a), null);
  const live = (s: RunDetail["stages"][number]) => d.item.state === "InProgress" && d.run?.open === true && s === newest;
  const took = (s: RunDetail["stages"][number]) =>
    !s.started_at ? "" : s.ended_at ? timeSpent(s.started_at, s.ended_at) : live(s) ? `${timeSpent(s.started_at, now)} so far` : "didn't finish";
  // PBI 209: an attempt with no end says it's running while it's live, and stopped once its cell is gone, so a stage
  // whose cell died reads as stopped beside the transcript it last uploaded.
  const status = (s: RunDetail["stages"][number]) => (s.status !== "started" || s.ended_at ? s.status : live(s) ? "running" : "stopped");
  // Each Tokens and Cost cell keeps the exact figures in its title, so hovering shows them in full.
  const exactTokens = (tokensIn: number | null, tokensOut: number | null) => `<td title="${escapeHtml(`${tokensIn ?? 0} in, ${tokensOut ?? 0} out`)}">`;
  const exactCost = (usd: string | number | null) => `<td title="${escapeHtml(`$${usd ?? 0}`)}">`;
  const policies = d.policies.length
    ? `<table><thead><tr><th scope="col">File</th><th scope="col">Criterion</th><th scope="col">Result</th><th scope="col">Reason</th></tr></thead><tbody>${d.policies
        .map((p) => `<tr><td>${escapeHtml(p.file)}.md <span class="muted">${escapeHtml(p.source)}</span></td><td>${escapeHtml(p.criterion)}</td><td>${escapeHtml(p.status)}</td><td>${escapeHtml(p.reason ?? "")}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="muted">No policy results yet.</p>`;
  const stages = d.stages.length
    ? `<table><thead><tr><th scope="col">Stage</th><th scope="col">Attempt</th><th scope="col">Status</th><th scope="col">Model</th><th scope="col">Started</th><th scope="col">Time spent</th><th scope="col">Tokens</th><th scope="col">Cost</th><th scope="col">Transcript</th><th scope="col">Notes</th></tr></thead><tbody>${d.stages
        .map((s) => `<tr><td>${escapeHtml(s.stage_id)}</td><td>${escapeHtml(s.attempt)}</td><td>${escapeHtml(status(s))}</td><td>${escapeHtml(s.model ?? "")}</td><td>${started(s)}</td><td>${escapeHtml(took(s))}</td>${exactTokens(s.tokens_in, s.tokens_out)}${escapeHtml(tokens(s.tokens_in ?? 0))} in, ${escapeHtml(tokens(s.tokens_out ?? 0))} out</td>${exactCost(s.cost_usd)}${escapeHtml(cost(s.cost_usd))}</td><td>${!s.transcript_ref ? "" : d.linkBlobs ? `<a href="/blobs/${escapeHtml(s.transcript_ref)}">transcript</a>` : escapeHtml(s.transcript_ref)}</td><td>${(s.restates ?? []).map((x) => `Needed a second ask of the PR reviewer in round ${escapeHtml(x.round)}: ${escapeHtml(x.reason)}`).join("<br>")}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="muted">No stage has run yet.</p>`;
  const readiness = d.readiness.length
    ? `<table><thead><tr><th scope="col">Ran</th><th scope="col">Call</th><th scope="col">Model</th><th scope="col">Tokens</th><th scope="col">Cost</th></tr></thead><tbody>${d.readiness
        .map((c) => `<tr><td>${local(c.ranAt, zone)}</td><td>${c.kind === "split" ? "Split proposal" : "Judge"}</td><td>${escapeHtml(c.model)}</td>${exactTokens(c.tokensIn, c.tokensOut)}${escapeHtml(tokens(c.tokensIn))} in, ${escapeHtml(tokens(c.tokensOut))} out</td>${exactCost(c.costUsd)}${escapeHtml(cost(c.costUsd))}</td></tr>`)
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
      ] as [string, string][], d.item.id)}`
    : "";
  return page(d.item.title, `<h1>${issueRef(d.item.external_id, d.item.repo)} ${escapeHtml(d.item.title)}</h1>
<p>${escapeHtml(d.item.state)}${r?.open ? withPr({ ...r, state: d.item.state }) : ""}${r?.next_stage ? `, resumes at ${escapeHtml(r.next_stage)}` : ""}</p>
<dl><dt>SOP version</dt><dd>${escapeHtml(r?.sop_version ?? "not pinned yet")}</dd><dt>Config</dt><dd>${escapeHtml(r?.config_sha ?? "not pinned yet")}</dd>
<dt>Scenarios locked at</dt><dd>${escapeHtml(r?.features_lock_sha ?? "not signed off")}</dd>
<dt>Shadow risk tier</dt><dd>${escapeHtml(r?.risk_tier ?? "not classified")}${r?.tier_reasons?.length ? `<ul>${r.tier_reasons.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>` : ""}</dd></dl>
${scope}${criteria}${pending}${form}${controls}${verdicts}${d.durations ? timeSection(d.durations) : ""}<h2>Policy results</h2>${policies}<h2>Stages</h2><p class="muted">Times show in ${escapeHtml(zone)}.</p>${stages}<h2>Readiness checks</h2>${readiness}${
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
const MOVES = new Set(["transition", "override", "sop_moved"]);

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
