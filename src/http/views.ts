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

export type ActiveRow = { id: string; title: string; state: string; stage: string | null; since: Date | null; cost: string; badges: string[] };
export type WaitingRow = { id: string; title: string; state: string; since: Date | null };
export type NotReadyRow = { id: string; title: string; failed: string[] };

export function age(since: Date | null, now = Date.now()): string {
  if (!since) return "";
  const minutes = Math.max(0, Math.round((now - since.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

const link = (id: string, title: string) => `<a href="/items/${escapeHtml(id)}">${escapeHtml(title)}</a>`;

export function floorPage(f: { active: ActiveRow[]; waiting: WaitingRow[]; waitingCount: number; capacity: number; next: { id: string; title: string }[]; notReady: NotReadyRow[] }, banner: string | null): string {
  const list = (rows: string[], empty: string) => (rows.length ? `<ol>${rows.join("")}</ol>` : `<p class="muted">${empty}</p>`);
  return page("Floor", `<h1>Floor</h1>
<p>${f.waitingCount} of ${f.capacity} waiting</p>
<h2>Waiting on you</h2>
${list(f.waiting.map((w) => `<li>${link(w.id, w.title)} <span class="muted">${escapeHtml(w.state)}, waiting ${escapeHtml(age(w.since))}</span></li>`), "Nothing waits on you.")}
<h2>Next up</h2>
${list(f.next.map((n) => `<li>${link(n.id, n.title)}</li>`), "Nothing is ready to start.")}
<h2>Not ready</h2>
${list(f.notReady.map((n) => `<li>${link(n.id, n.title)}<ul>${n.failed.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul></li>`), "Every item that entered is ready.")}
<h2>In flight</h2>
${f.active.length ? `<table><thead><tr><th scope="col">Item</th><th scope="col">State</th><th scope="col">Stage</th><th scope="col">In stage</th><th scope="col">Cost</th></tr></thead><tbody>
${f.active.map((a) => `<tr><td>${link(a.id, a.title)} ${a.badges.map((b) => `<span class="badge">${escapeHtml(b)}</span>`).join(" ")}</td><td>${escapeHtml(a.state)}</td><td>${escapeHtml(a.stage ?? "")}</td><td>${escapeHtml(age(a.since))}</td><td>$${escapeHtml(a.cost)}</td></tr>`).join("\n")}
</tbody></table>` : `<p class="muted">No item is in flight.</p>`}
<script>
// Floor updates live from the event log: reload a second after the last event, so a burst reloads once.
let reload; new EventSource("/events").onmessage = () => { clearTimeout(reload); reload = setTimeout(() => location.reload(), 1000); };
</script>`, banner);
}

export type RunDetail = {
  item: { id: string; title: string; state: string };
  run: { sop_version: string | null; config_sha: string | null; scenarios_sha: string | null; features_lock_sha: string | null; risk_tier: string | null; tier_reasons: string[] | null; next_stage: string | null } | null;
  policies: { file: string; source: string; criterion: string; status: string; reason: string | null }[];
  stages: { stage_id: string; attempt: number; model: string | null; tokens_in: number | null; tokens_out: number | null; cost_usd: string | null; status: string; transcript_ref: string | null }[];
  question: { kind: string; body: string } | null;
  criteria: { criterion: string; scenarios: string[] }[] | null;
  /** The signed-off feature files at the lock sha. */
  features: { path: string; text: string }[];
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
        .map((s) => `<tr><td>${escapeHtml(s.stage_id)}</td><td>${escapeHtml(s.attempt)}</td><td>${escapeHtml(s.status)}</td><td>${escapeHtml(s.model ?? "")}</td><td>${escapeHtml(s.tokens_in ?? 0)} in, ${escapeHtml(s.tokens_out ?? 0)} out</td><td>$${escapeHtml(s.cost_usd ?? "0")}</td><td>${s.transcript_ref ? escapeHtml(s.transcript_ref) : ""}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="muted">No stage has run yet.</p>`;
  const criteria = d.criteria
    ? `<h2>Criteria and their scenarios</h2><ol>${d.criteria
        .map((c) => `<li>${escapeHtml(c.criterion)}${c.scenarios.length ? `<ul>${c.scenarios.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : ` <strong>no scenario</strong>`}</li>`)
        .join("")}</ol>`
    : "";
  const id = escapeHtml(d.item.id);
  const form = d.question?.kind === "sign_off"
    ? `<h2>Sign off</h2><form method="post" action="/items/${id}/signoff"><label for="note">Note for the factory</label><textarea id="note" name="note"></textarea>
<p><button name="decision" value="approve">Approve the scenarios</button> <button name="decision" value="changes">Ask for changes</button></p></form>`
    : d.question?.kind === "needs_input"
      ? `<h2>Answer</h2><p>${escapeHtml(d.question.body)}</p><form method="post" action="/items/${id}/answer"><label for="answer">Your answer</label><textarea id="answer" name="answer" required></textarea><p><button>Send the answer</button></p></form>`
      : "";
  return page(d.item.title, `<h1>${escapeHtml(d.item.title)}</h1>
<p>${escapeHtml(d.item.state)}${r?.next_stage ? `, resumes at ${escapeHtml(r.next_stage)}` : ""}</p>
<dl><dt>SOP version</dt><dd>${escapeHtml(r?.sop_version ?? "not pinned yet")}</dd><dt>Config</dt><dd>${escapeHtml(r?.config_sha ?? "not pinned yet")}</dd>
<dt>Scenarios locked at</dt><dd>${escapeHtml(r?.features_lock_sha ?? "not signed off")}</dd>
<dt>Shadow risk tier</dt><dd>${escapeHtml(r?.risk_tier ?? "not classified")}${r?.tier_reasons?.length ? `<ul>${r.tier_reasons.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>` : ""}</dd></dl>
${form}${criteria}<h2>Policy results</h2>${policies}<h2>Stages</h2>${stages}${
    d.features.length
      ? `<h2>Signed-off scenarios</h2>${d.features.map((f) => `<h3>${escapeHtml(f.path)}</h3><pre>${escapeHtml(f.text)}</pre>`).join("")}`
      : ""
  }`, banner);
}
