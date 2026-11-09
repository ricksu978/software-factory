// Dashboard HTML (plan Task 15). Every value goes through escapeHtml, and colours are custom properties with a
// dark-mode override.

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

export function age(since: Date | null, now = Date.now()): string {
  if (!since) return "";
  const minutes = Math.max(0, Math.round((now - since.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

/** A time in UTC to the minute, with its full ISO form in the markup. */
const utc = (at: Date) => `<time datetime="${escapeHtml(at.toISOString())}">${escapeHtml(at.toISOString().slice(0, 16).replace("T", " "))}</time>`;
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

export function floorPage(f: { active: ActiveRow[]; waiting: WaitingRow[]; waitingCount: number; capacity: number; next: (Issue & { id: string; title: string })[];
  notReady: NotReadyRow[]; factory: { kind: string; reason: string }[]; canOperate: boolean; restart?: Restart | null }, banner: string | null): string {
  const list = (rows: string[], empty: string) => (rows.length ? `<ol>${rows.join("")}</ol>` : `<p class="muted">${empty}</p>`);
  const status = f.factory.filter((o) => factoryState[o.kind]).map((o) => `<p class="banner" role="status">${factoryState[o.kind]}: ${escapeHtml(o.reason)}</p>`).join("")
    + (f.restart ? restartStatus(f.restart) : "");
  const controls = f.canOperate
    ? `<h2>Controls</h2>${overrideForm([["pause", "Pause"], ["drain", "Drain"], ["resume", "Resume"], ["kill", "Kill switch"], ["restart", "Prepare restart"]], null)}`
    : "";
  return page("Floor", `<h1>Floor</h1>${status}
<p>${f.waitingCount} of ${f.capacity} waiting. <a href="/activity">Activity</a> <a href="/phase0">Phase 0 report</a></p>
<h2>Waiting on you</h2>
${list(f.waiting.map((w) => `<li>${named(w)}${withPr(w)} <span class="muted">${escapeHtml(w.state)}, waiting ${escapeHtml(age(w.since))}</span></li>`), "Nothing waits on you.")}
<h2>Next up</h2>
${list(f.next.map((n) => `<li>${named(n)}</li>`), "Nothing is ready to start.")}
<h2>Not ready</h2>
${list(f.notReady.map((n) => `<li>${named(n)}<ul>${n.failed.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul></li>`), "Every item that entered is ready.")}
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
  stages: { stage_id: string; attempt: number; model: string | null; tokens_in: number | null; tokens_out: number | null; cost_usd: string | null; status: string; transcript_ref: string | null }[];
  /** Every readiness judge and split call on the item, oldest first, a failed one's included (PBI 132). */
  readiness: { kind?: "judge" | "split"; model: string; tokensIn: number; tokensOut: number; costUsd: number; ranAt: Date }[];
  question: { kind: string; body: string } | null;
  criteria: { criterion: string; scenarios: Scenario[] }[] | null;
  /** The signed-off feature files at the lock sha. */
  features: { path: string; text: string }[];
  /** The item's scenarios with their verdicts in the latest red and green reports. */
  verdicts: { name: string; red: string; green: string }[];
  /** True when the stored transcripts can be served, so each one is a link. */
  linkBlobs: boolean;
  /** An operator's override buttons for this item, or null for anyone else. */
  controls: { held: boolean; stoppable: boolean; requeueable: boolean } | null;
};

export function runDetailPage(d: RunDetail, banner: string | null): string {
  const r = d.run;
  const policies = d.policies.length
    ? `<table><thead><tr><th scope="col">File</th><th scope="col">Criterion</th><th scope="col">Result</th><th scope="col">Reason</th></tr></thead><tbody>${d.policies
        .map((p) => `<tr><td>${escapeHtml(p.file)}.md <span class="muted">${escapeHtml(p.source)}</span></td><td>${escapeHtml(p.criterion)}</td><td>${escapeHtml(p.status)}</td><td>${escapeHtml(p.reason ?? "")}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="muted">No policy results yet.</p>`;
  const stages = d.stages.length
    ? `<table><thead><tr><th scope="col">Stage</th><th scope="col">Attempt</th><th scope="col">Status</th><th scope="col">Model</th><th scope="col">Tokens</th><th scope="col">Cost</th><th scope="col">Transcript</th></tr></thead><tbody>${d.stages
        .map((s) => `<tr><td>${escapeHtml(s.stage_id)}</td><td>${escapeHtml(s.attempt)}</td><td>${escapeHtml(s.status)}</td><td>${escapeHtml(s.model ?? "")}</td><td>${escapeHtml(s.tokens_in ?? 0)} in, ${escapeHtml(s.tokens_out ?? 0)} out</td><td>$${escapeHtml(s.cost_usd ?? "0")}</td><td>${!s.transcript_ref ? "" : d.linkBlobs ? `<a href="/blobs/${escapeHtml(s.transcript_ref)}">transcript</a>` : escapeHtml(s.transcript_ref)}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="muted">No stage has run yet.</p>`;
  const readiness = d.readiness.length
    ? `<table><thead><tr><th scope="col">Ran (UTC)</th><th scope="col">Call</th><th scope="col">Model</th><th scope="col">Tokens</th><th scope="col">Cost</th></tr></thead><tbody>${d.readiness
        .map((c) => `<tr><td>${utc(c.ranAt)}</td><td>${c.kind === "split" ? "Split proposal" : "Judge"}</td><td>${escapeHtml(c.model)}</td><td>${escapeHtml(c.tokensIn)} in, ${escapeHtml(c.tokensOut)} out</td><td>${judgeUsd(c.costUsd)}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="muted">No readiness check has run yet.</p>`;
  const criteria = d.criteria
    ? `<h2>Criteria and their scenarios</h2><ol>${d.criteria
        .map((c) => `<li>${escapeHtml(c.criterion)}${c.scenarios.length ? `<ul>${c.scenarios.map((s) => `<li>${escapeHtml(s.name)}${s.regression ? ` <strong>expected to pass at Red</strong>` : ""}</li>`).join("")}</ul>` : ` <strong>no scenario</strong>`}</li>`)
        .join("")}</ol>`
    : "";
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
${form}${controls}${criteria}${verdicts}<h2>Policy results</h2>${policies}<h2>Stages</h2>${stages}<h2>Readiness checks</h2>${readiness}${
    d.features.length
      ? `<h2>Signed-off scenarios</h2>${d.features.map((f) => `<h3>${escapeHtml(f.path)}</h3><pre>${escapeHtml(f.text)}</pre>`).join("")}`
      : ""
  }`, banner);
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

/** One event as the activity log reads it: only `from`, `to` and `event` come out of the payload. */
export type ActivityRow = { at: Date; external_id: string | null; repo: string | null; title: string | null; kind: string; from: string | null; to: string | null; event: string | null };

// Only a move between states shows where the item came from and went. Another kind's from and to stay off the page.
const MOVES = new Set(["transition", "override"]);

/** The factory's newest events, newest first, with the time in UTC (PBI 105). */
export function activityPage(rows: ActivityRow[], banner: string | null): string {
  const cell = (r: ActivityRow) => {
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
