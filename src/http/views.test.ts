import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runInNewContext } from "node:vm";
import { activityPage, configurationPage, floorPage, issueRef, phase0Page, prLink, runDetailPage, type RunDetail } from "./views.ts";

describe("activityPage", () => {
  const at = new Date("2026-11-07T09:05:00Z");

  test("shows a transition's time, item, kind, states and event, one row each", () => {
    const html = activityPage([{ at, external_id: "95", repo: null, title: "Export a month", kind: "transition", from: "Queued", to: "InProgress", event: "claimed" }], null);
    assert.match(html, /<title>Activity<\/title>/);
    const row = /<tbody>([\s\S]*)<\/tbody>/.exec(html)![1];
    assert.match(row, /<time datetime="2026-11-07T09:05:00.000Z">2026-11-07 09:05<\/time>/);
    for (const v of ["95", "Export a month", "transition", "Queued", "InProgress", "claimed"]) assert.ok(row.includes(v), v);
  });

  test("shows an override's states without an event, and no states for any other kind", () => {
    const html = activityPage([
      { at, external_id: "95", repo: null, title: "t", kind: "override", from: "InProgress", to: "Failed", event: null },
      { at, external_id: "95", repo: null, title: "t", kind: "comment", from: "Queued", to: "Failed", event: "x" },
    ], null);
    const [override, comment] = [...html.matchAll(/<tr><td>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
    assert.match(override, /InProgress/);
    assert.match(override, /Failed/);
    assert.doesNotMatch(comment, /Queued|Failed|>x</);
  });

  test("shows an SOP move's old and new versions", () => {
    const html = activityPage([{ at, external_id: "482", repo: null, title: "t", kind: "sop_moved", from: "0.1.0", to: "0.2.0", event: null }], null);
    const row = /<tbody>([\s\S]*)<\/tbody>/.exec(html)![1];
    assert.match(row, /sop_moved/);
    assert.match(row, /0\.1\.0 → 0\.2\.0/);
  });

  test("escapes titles and says so when nothing has happened", () => {
    const html = activityPage([{ at, external_id: "<i>", repo: null, title: "<script>alert(1)</script>", kind: "transition", from: "Queued", to: "InProgress", event: "claimed" }], null);
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.doesNotMatch(html, /<script>alert|<i>/);
    assert.match(activityPage([], null), /No event yet/);
  });

  test("shows a setting change with who made it, the setting and its old and new values", () => {
    const html = activityPage([{ at, external_id: null, repo: null, title: null, kind: "setting", from: "25", to: null, event: null, actor: "octo", setting: "daily budget" }], null);
    assert.match(html, /octo changed daily budget from 25 to not set/);
  });

  test("shows a setting change's reason as text", () => {
    const html = activityPage([{ at, external_id: null, repo: null, title: null, kind: "setting", from: "3", to: "5", event: null, actor: "octo", setting: "review capacity", reason: "<b>urgent</b> & now" }], null);
    assert.match(html, /octo changed review capacity from 3 to 5 because &lt;b&gt;urgent&lt;\/b&gt; &amp; now/);
    assert.doesNotMatch(html, /<b>urgent/);
  });
});

describe("configurationPage", () => {
  const runtime = [
    { key: "mode", label: "WIP mode", value: "fixed", editable: false },
    { key: "review_capacity", label: "review capacity", value: "3", editable: true },
    { key: "daily_budget", label: "daily budget", value: null, editable: true, note: "Stored, but not enforced yet." },
  ];
  const env = [{ key: "FACTORY_POLICY_DIR", label: "FACTORY_POLICY_DIR", value: "<b>x</b>" }, { key: "FACTORY_KILL", label: "FACTORY_KILL", value: null }];

  test("gives an operator a form for each setting they can change, and none for the ones the factory sets", () => {
    const html = configurationPage({ runtime, env, canOperate: true }, null);
    assert.match(html, /<h1>Configuration<\/h1>/);
    assert.match(html, /name="setting" value="review_capacity"/);
    assert.match(html, /name="setting" value="daily_budget"/);
    assert.doesNotMatch(html, /value="mode"/);
    assert.equal(html.match(/<input id="reason-[a-z_]+" name="reason" required>/g)?.length, 2, "each form asks for a reason");
    const envPart = html.slice(html.indexOf("<h2>Env-backed settings</h2>"));
    assert.doesNotMatch(envPart, /<form|<input|<button/);
  });

  test("gives an operator a button to clear an active usage pause, and none once it's cleared or run out, or to a viewer (PBI 178)", () => {
    const now = new Date("2026-11-13T12:00:00Z");
    const pause = (value: string | null) => [{ key: "usage_pause", label: "usage pause", value, editable: false, clearable: true }];
    const row = (html: string) => /<tr><th scope="row">usage pause<\/th>([\s\S]*?)<\/tr>/.exec(html)![1];
    const active = row(configurationPage({ runtime: pause("2026-11-14T09:00:00Z"), env, canOperate: true, now }, null));
    assert.match(active, /<form method="post" action="\/configuration"><input type="hidden" name="setting" value="usage_pause"><input type="hidden" name="value" value="">/);
    assert.match(active, /<input id="reason-usage_pause" name="reason" required>/);
    assert.match(active, /<button>Clear<\/button>/);
    assert.doesNotMatch(row(configurationPage({ runtime: pause(null), env, canOperate: true, now }, null)), /<form|<input|<button/);
    for (const until of ["2026-11-13T11:00:00Z", "2026-11-13T12:00:00Z"]) {
      assert.doesNotMatch(row(configurationPage({ runtime: pause(until), env, canOperate: true, now }, null)), /<form|<input|<button/, `a pause that ran out at ${until}`);
    }
    assert.doesNotMatch(configurationPage({ runtime: pause("2026-11-14T09:00:00Z"), env, canOperate: false, now }, null), /<form|<input|<button/);
  });

  test("shows a setting's note to an operator and a viewer alike", () => {
    for (const canOperate of [true, false]) assert.match(configurationPage({ runtime, env, canOperate }, null), /Stored, but not enforced yet\./);
  });

  test("gives a viewer no form at all", () => {
    assert.doesNotMatch(configurationPage({ runtime, env, canOperate: false }, null), /<form|<input|<button|<select|<textarea/);
  });

  test("marks each env-backed setting as needing a restart, shows a missing value as not set and escapes values", () => {
    const html = configurationPage({ runtime, env, canOperate: false, error: "<i>no</i>" }, null);
    const envPart = html.slice(html.indexOf("<h2>Env-backed settings</h2>"));
    assert.equal(envPart.match(/Needs a restart/g)?.length, 2);
    assert.doesNotMatch(html.slice(0, html.indexOf("<h2>Env-backed settings</h2>")), /Needs a restart/);
    assert.match(envPart, /not set/);
    assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;"));
    assert.doesNotMatch(html, /<b>x|<i>no/);
  });
});

describe("floorPage", () => {
  test("links to the activity log", () => {
    const html = floorPage({ active: [], waiting: [], waitingCount: 0, capacity: 3, next: [], notReady: [], factory: [], canOperate: false }, null);
    assert.match(html, /<a href="\/activity">/);
    assert.match(html, /<a href="\/configuration">Configuration<\/a>/);
  });
});

describe("issueRef", () => {
  // PBI 140: Prepare restart sits among the factory's Controls, and Floor counts down its wrap-up until no cell runs.
  const floor = (restart: { minutesLeft: number; running: number } | null, canOperate = true) =>
    floorPage({ active: [], waiting: [], waitingCount: 0, capacity: 3, next: [], notReady: [], factory: [], canOperate, restart }, null);

  test("offers Prepare restart among the Controls to an operator", () => {
    assert.match(floor(null), /<button name="kind" value="restart">Prepare restart<\/button>/);
    assert.doesNotMatch(floor(null, false), /Prepare restart/);
  });

  test("counts down the wrap-up while a cell still runs, and says it's ready once none does", () => {
    assert.match(floor({ minutesLeft: 9, running: 2 }), /Preparing to restart: 2 cells are wrapping up, with 9 minutes left/);
    assert.match(floor({ minutesLeft: 1, running: 1 }), /1 cell is wrapping up, with 1 minute left/);
    const ready = floor({ minutesLeft: 9, running: 0 });
    assert.match(ready, /Ready to restart\. No cell is running, so it&#39;s safe to restart the factory or stop Docker\./);
    assert.doesNotMatch(ready, /Preparing to restart/);
    assert.doesNotMatch(floor(null), /restart\./);
  });

  test("links #N to its issue on GitHub when the repo is known", () => {
    assert.equal(issueRef("131", "acme/widgets"), `<a href="https://github.com/acme/widgets/issues/131">#131</a>`);
  });

  test("shows #N unlinked when the repo is unknown", () => {
    assert.equal(issueRef("131", null), "#131");
  });

  test("escapes the number and never links one that isn't a number", () => {
    assert.equal(issueRef("<b>131</b>", "acme/widgets"), "#&lt;b&gt;131&lt;/b&gt;");
  });

  test("shows nothing for an event with no item", () => {
    assert.equal(issueRef(null, null), "");
  });
});

describe("pages that name an item", () => {
  const issue = { external_id: "131", repo: "acme/widgets" };
  const before = (html: string) => assert.match(html, /<a href="https:\/\/github.com\/acme\/widgets\/issues\/131">#131<\/a> <a href="\/items\/i1">Export a month<\/a>/);

  test("Floor shows #N before the title in each list", () => {
    const row = { id: "i1", title: "Export a month", ...issue };
    const html = floorPage({
      active: [{ ...row, state: "InProgress", stage: null, since: null, cost: "0", badges: [], message: null }],
      waiting: [{ ...row, state: "SignOff", since: null }], waitingCount: 1, capacity: 3, next: [row],
      notReady: [{ ...row, failed: [] }], factory: [], canOperate: false,
    }, null);
    assert.equal(html.match(/issues\/131">#131<\/a> <a href="\/items\/i1">/g)?.length, 4);
  });

  test("the Phase 0 report shows #N before the title", () => {
    before(phase0Page([{ item_id: "i1", title: "Export a month", ...issue, pr_url: null, merged_at: null, cost: 0, risk_tier: null, tier_reasons: null }], 0, null));
  });

  test("the activity log shows #N in the item's column", () => {
    const html = activityPage([{ at: new Date(), external_id: "131", repo: "acme/widgets", title: "Export a month", kind: "transition", from: "Queued", to: "InProgress", event: "claimed" }], null);
    assert.match(html, /<td><a href="https:\/\/github.com\/acme\/widgets\/issues\/131">#131<\/a><\/td><td>Export a month<\/td>/);
  });
});

describe("prLink", () => {
  // PBI 145: an InReview item shows "PR #N", linked to the PR its open run holds.
  test("links PR #N to the open run's PR address, its text from the PR number", () => {
    assert.equal(prLink({ state: "InReview", pr_number: 42, pr_url: "https://github.example.com/acme/widgets/pull/42" }),
      `<a href="https://github.example.com/acme/widgets/pull/42">PR #42</a>`);
  });

  test("shows nothing when the open run has no PR address or number, or the item isn't InReview", () => {
    assert.equal(prLink({ state: "InReview", pr_number: 42, pr_url: null }), "");
    assert.equal(prLink({ state: "InReview", pr_number: null, pr_url: "https://github.com/acme/widgets/pull/42" }), "");
    assert.equal(prLink({ state: "SignOff", pr_number: 42, pr_url: "https://github.com/acme/widgets/pull/42" }), "");
    assert.equal(prLink({ state: "InReview" }), "");
  });

  test("escapes the address, so it never shows as markup", () => {
    assert.equal(prLink({ state: "InReview", pr_number: 42, pr_url: `https://x/pull/42"><b>x</b>` }), `<a href="https://x/pull/42&quot;&gt;&lt;b&gt;x&lt;/b&gt;">PR #42</a>`);
  });

  const pr = { state: "InReview", pr_number: 42, pr_url: "https://github.com/acme/widgets/pull/42" };
  const linked = `<a href="https://github.com/acme/widgets/pull/42">PR #42</a>`;

  test("Floor shows it under Waiting on you and in the In flight table", () => {
    const row = { id: "i1", title: "Export a month", external_id: "145", repo: "acme/widgets" };
    const html = floorPage({
      active: [{ ...row, ...pr, stage: "review", since: null, cost: "0", badges: [], message: null }],
      waiting: [{ ...row, ...pr, since: null }], waitingCount: 1, capacity: 3, next: [], notReady: [], factory: [], canOperate: false,
    }, null);
    assert.match(html, new RegExp(`<li>[^\\n]*${linked}[^\\n]*</li>`));
    assert.match(html, new RegExp(`<tr><td>[^\\n]*${linked}[^\\n]*</tr>`));
  });

  test("Run detail shows it on the line with the item's state", () => {
    const html = runDetailPage({
      item: { id: "i1", title: "Export a month", external_id: "145", repo: "acme/widgets", state: "InReview" },
      run: { sop_version: null, config_sha: null, scenarios_sha: null, features_lock_sha: null, risk_tier: null, tier_reasons: null, next_stage: "review", pr_number: 42, pr_url: pr.pr_url, open: true },
      policies: [], stages: [], readiness: [], question: null, criteria: null, scope: null, pending: [], features: [], verdicts: [], linkBlobs: false, controls: null,
    }, null);
    assert.match(html, new RegExp(`<p>InReview[^<]*${linked}`));
  });

  test("Run detail shows no link when the latest run has ended", () => {
    const html = runDetailPage({
      item: { id: "i1", title: "Export a month", external_id: "145", repo: "acme/widgets", state: "InReview" },
      run: { sop_version: null, config_sha: null, scenarios_sha: null, features_lock_sha: null, risk_tier: null, tier_reasons: null, next_stage: null, pr_number: 42, pr_url: pr.pr_url, open: false },
      policies: [], stages: [], readiness: [], question: null, criteria: null, scope: null, pending: [], features: [], verdicts: [], linkBlobs: false, controls: null,
    }, null);
    assert.doesNotMatch(html, /PR #42/);
  });
});

describe("runDetailPage at sign-off", () => {
  const detail = (over: Partial<RunDetail> = {}): RunDetail => ({
    item: { id: "00000000-0000-0000-0000-000000000146", external_id: "146", repo: "octo/repo", title: "t", state: "SignOff" },
    run: null, policies: [], stages: [], readiness: [], question: { kind: "sign_off", body: "q" },
    criteria: [{ criterion: "The owner sees the scope", scenarios: [] }], scope: null, pending: [], features: [],
    verdicts: [], linkBlobs: false, controls: null, ...over,
  });

  test("shows the scope with its lines and escaped, then the criteria and the files, all before the buttons", () => {
    const html = runDetailPage(detail({ scope: "## Why\n<b>bold</b>", pending: [{ path: "features/a.feature", text: "Feature: <i>a</i>" }] }), null);
    const at = ["<h2>Scope</h2>", "Criteria and their scenarios", "<h3>features/a.feature</h3>", "Approve the scenarios", "Ask for changes"].map((s) => html.indexOf(s));
    assert.ok(at.every((n, i) => n >= 0 && (i === 0 || n > at[i - 1])), JSON.stringify(at));
    assert.match(html, /## Why\n&lt;b&gt;bold&lt;\/b&gt;/);
    assert.match(html, /Feature: &lt;i&gt;a&lt;\/i&gt;/);
  });

  test("shows no Scope section when there's no scope", () => {
    assert.doesNotMatch(runDetailPage(detail(), null), /<h2>Scope<\/h2>/);
  });
});

describe("readiness spend (PBI 132)", () => {
  const detail = (readiness: RunDetail["readiness"]): RunDetail => ({
    item: { id: "i1", title: "Checkout redesign", state: "NotReady", external_id: "132", repo: null }, run: null, policies: [],
    stages: [{ stage_id: "specify", attempt: 1, model: "claude-opus-5-5", tokens_in: 5000, tokens_out: 900, cost_usd: "0.42", status: "passed", transcript_ref: null }],
    readiness, question: null, criteria: null, scope: null, pending: [], features: [], verdicts: [], linkBlobs: false, controls: null,
  });

  test("Run detail lists each readiness check right after the stages, with its time, model, tokens and cost", () => {
    const html = runDetailPage(detail([{ model: "claude-haiku-4-5", tokensIn: 1200, tokensOut: 80, costUsd: 0.0031, ranAt: new Date("2026-11-09T10:15:00Z") }]), null);
    const section = /<h2>Stages<\/h2>[\s\S]*?<h2>Readiness checks<\/h2>([\s\S]*?)(<h2>|<\/main>)/.exec(html)?.[1];
    assert.ok(section, "no Readiness checks section right after Stages");
    const row = /<tbody>([\s\S]*)<\/tbody>/.exec(section)![1];
    assert.match(row, /<time datetime="2026-11-09T10:15:00.000Z">2026-11-09 10:15<\/time>/);
    for (const v of ["claude-haiku-4-5", "1.2k in, 80 out", "&lt;$0.01"]) assert.ok(row.includes(v), v);
  });

  test("Run detail names each check's call, the judge or the split proposal", () => {
    const at = new Date("2026-11-09T10:15:00Z");
    const html = runDetailPage(detail([
      { model: "claude-haiku-4-5", tokensIn: 1200, tokensOut: 80, costUsd: 0.0031, ranAt: at },
      { kind: "split", model: "claude-opus-5-5", tokensIn: 4000, tokensOut: 600, costUsd: 0.21, ranAt: at },
    ]), null);
    const rows = [.../<tbody>([\s\S]*?)<\/tbody>/.exec(html.split("<h2>Readiness checks</h2>")[1])![1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
    assert.match(rows[0], /<td>Judge<\/td><td>claude-haiku-4-5<\/td>/);
    assert.match(rows[1], /<td>Split proposal<\/td><td>claude-opus-5-5<\/td>.*<td title="\$0\.21">\$0\.21<\/td>/);
  });

  test("Run detail's stage row says when the PR reviewer needed a second ask, and why (PBI 190)", () => {
    const d = detail([]);
    d.stages = [{ ...d.stages[0], stage_id: "pr-review", restates: [{ round: 2, reason: "its last line is neither APPROVED nor OPEN: <n>: <b>fine</b>" }] }];
    const row = /<tbody>([\s\S]*?)<\/tbody>/.exec(runDetailPage(d, null).split("<h2>Stages</h2>")[1])![1];
    assert.match(row, /Needed a second ask of the PR reviewer in round 2: its last line is neither APPROVED nor OPEN: &lt;n&gt;: &lt;b&gt;fine&lt;\/b&gt;/);
  });

  test("Run detail says so when no readiness check has run", () => {
    assert.match(runDetailPage(detail([]), null), /<h2>Readiness checks<\/h2><p class="muted">No readiness check has run yet.<\/p>/);
  });

  test("the Phase 0 report shows readiness spend beside stage spend, to four places", () => {
    const html = phase0Page([{ item_id: "i1", title: "Pay by card", external_id: "1", repo: null, pr_url: null, merged_at: null, cost: 2, risk_tier: null, tier_reasons: null }], 0.0092, null);
    assert.match(html, /<dl><dt>Stage spend<\/dt><dd>\$2\.00<\/dd><dt>Readiness spend<\/dt><dd>\$0\.0092<\/dd><\/dl>/);
  });
});

describe("Run detail's readable numbers and local times (PBI 189)", () => {
  const stage = { stage_id: "build", attempt: 1, model: "claude-opus-5-5", tokens_in: 2149999, tokens_out: 48210, cost_usd: "0.5291", status: "passed", transcript_ref: null,
    started_at: new Date("2026-11-09T15:30:00Z"), ended_at: new Date("2026-11-09T16:42:20Z") };
  const detail = (over: Partial<RunDetail>): RunDetail => ({
    item: { id: "i1", title: "Export a month", state: "InProgress", external_id: "189", repo: null }, run: null, policies: [], stages: [stage],
    readiness: [{ model: "claude-haiku-4-5", tokensIn: 1240, tokensOut: 80, costUsd: 0.055, ranAt: new Date("2026-11-09T23:30:00Z") }],
    question: null, criteria: null, scope: null, pending: [], features: [], verdicts: [], linkBlobs: false, controls: null, ...over,
  });
  const openRun: RunDetail["run"] = { sop_version: null, config_sha: null, scenarios_sha: null, features_lock_sha: null, risk_tier: null, tier_reasons: null, next_stage: "build", open: true };
  const rowOf = (html: string, section: string) => /<tbody><tr>([\s\S]*?)<\/tr>/.exec(html.split(`<h2>${section}</h2>`)[1])![1];

  test("the Stages table shows readable tokens and cost, when the attempt started in the viewer's zone, and how long it took", () => {
    const row = rowOf(runDetailPage(detail({ zone: "America/New_York" }), null), "Stages");
    assert.match(row, /<td><time datetime="2026-11-09T15:30:00.000Z">2026-11-09 10:30<\/time><\/td><td>1h 12m<\/td><td title="2149999 in, 48210 out">2.1m in, 48.2k out<\/td><td title="\$0.5291">\$0.53<\/td>/);
  });

  test("an attempt still running shows the time so far", () => {
    const html = runDetailPage(detail({ stages: [{ ...stage, ended_at: null, status: "started" }], run: openRun, now: new Date("2026-11-09T15:36:30Z") }), null);
    assert.match(rowOf(html, "Stages"), /<td>6m 30s so far<\/td>/);
  });

  test("an attempt left without an end once its item or run moved on doesn't count on against now", () => {
    const dead = { stages: [{ ...stage, ended_at: null, status: "started" }], now: new Date("2026-11-10T17:35:00Z") };
    for (const over of [{ run: { ...openRun, open: false } }, { run: openRun, item: { ...detail({}).item, state: "Queued" } }, {}]) {
      const row = rowOf(runDetailPage(detail({ ...dead, ...over }), null), "Stages");
      assert.match(row, /<td>didn&#39;t finish<\/td>|<td>didn't finish<\/td>/);
      assert.doesNotMatch(row, /so far/);
    }
  });

  test("a dead cell's attempt left open on a run a new cell claimed doesn't count on against now", () => {
    const deadRow = { ...stage, ended_at: null, status: "started", started_at: new Date("2026-11-09T15:30:00Z") };
    const liveRow = { ...stage, attempt: 2, ended_at: null, status: "started", started_at: new Date("2026-11-10T17:30:00Z") };
    const html = runDetailPage(detail({ stages: [deadRow, liveRow], run: openRun, now: new Date("2026-11-10T17:35:00Z") }), null);
    const rows = html.split("<h2>Stages</h2>")[1].split("</tbody>")[0].split("<tr>").slice(2);
    assert.match(rows[0], /<td>didn&#39;t finish<\/td>|<td>didn't finish<\/td>/);
    assert.doesNotMatch(rows[0], /so far/);
    assert.match(rows[1], /<td>5m 0s so far<\/td>/);
  });

  test("an attempt left open by a cell that died shows as stopped, and a live one as running (PBI 209)", () => {
    const deadRow = { ...stage, ended_at: null, status: "started", started_at: new Date("2026-11-09T15:30:00Z") };
    const liveRow = { ...stage, attempt: 2, ended_at: null, status: "started", started_at: new Date("2026-11-10T17:30:00Z") };
    const html = runDetailPage(detail({ stages: [deadRow, liveRow], run: openRun, now: new Date("2026-11-10T17:35:00Z") }), null);
    const rows = html.split("<h2>Stages</h2>")[1].split("</tbody>")[0].split("<tr>").slice(2);
    assert.match(rows[0], /<td>build<\/td><td>1<\/td><td>stopped<\/td>/);
    assert.match(rows[1], /<td>build<\/td><td>2<\/td><td>running<\/td>/);
    const queued = rowOf(runDetailPage(detail({ stages: [deadRow], run: openRun, item: { ...detail({}).item, state: "Queued" } }), null), "Stages");
    assert.match(queued, /<td>build<\/td><td>1<\/td><td>stopped<\/td>/);
  });

  test("the Readiness checks table shows readable tokens and cost, and when the check ran in the viewer's zone", () => {
    const row = rowOf(runDetailPage(detail({ zone: "Asia/Tokyo" }), null), "Readiness checks");
    assert.match(row, /2026-11-10 08:30<\/time><\/td><td>Judge<\/td><td>claude-haiku-4-5<\/td><td title="1240 in, 80 out">1.2k in, 80 out<\/td><td title="\$0.055">\$0.06<\/td>/);
  });

  test("no column heading says UTC, and the page says which zone its times show in", () => {
    const html = runDetailPage(detail({}), null);
    assert.doesNotMatch(html, /<th[^>]*>[^<]*UTC/);
    assert.match(html, /Times show in UTC\./);
    assert.match(html, /document\.cookie = sent/);
  });

  /** Runs the page's zone script in a browser in `tz` whose cookie jar keeps writes or not, and counts reloads. */
  const runZoneScript = (html: string, tz: string, keepsCookies: boolean, jar = "") => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    let reloads = 0;
    const document = {
      get cookie() { return jar; },
      set cookie(v: string) { if (keepsCookies) jar = v.split(";")[0]; },
    };
    runInNewContext(script, { document, location: { reload: () => reloads++ }, Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: tz }) }) } });
    return reloads;
  };

  test("a browser in another zone sets the cookie and reloads once", () => {
    const html = runDetailPage(detail({}), null);
    assert.equal(runZoneScript(html, "Europe/Paris", true), 1);
    assert.equal(runZoneScript(html, "Europe/Paris", true, "tz=Europe%2FParis"), 0);
  });

  test("a browser that blocks cookies never reloads, so the page can't loop", () => {
    assert.equal(runZoneScript(runDetailPage(detail({}), null), "Europe/Paris", false), 0);
  });

  test("a browser already in the page's zone doesn't reload", () => {
    assert.equal(runZoneScript(runDetailPage(detail({ zone: "Europe/Paris" }), null), "Europe/Paris", true), 0);
  });
});

describe("Run detail's Time section (PBI 187)", () => {
  const detail = (durations?: RunDetail["durations"]): RunDetail => ({
    item: { id: "i1", title: "Export a month", state: "InProgress", external_id: "187", repo: "acme/widgets" }, run: null, policies: [], stages: [],
    readiness: [], question: null, criteria: null, scope: null, pending: [], features: [], verdicts: [], linkBlobs: false, controls: null, durations,
  });
  const M = 60_000;
  const section = (html: string) => /<h2>Time<\/h2>([\s\S]*?)<h2>/.exec(html)?.[1] ?? "";

  test("shows the total, Queued and each wait with their total, as hours and minutes", () => {
    const html = section(runDetailPage(detail({
      totalMs: 25 * 60 * M, queuedMs: 140 * M,
      waiting: { signOffMs: 150 * M, needsInputMs: 45 * M, inReviewMs: 180 * M, totalMs: 375 * M }, stages: [],
    }), null));
    for (const [dt, dd] of [["Total", "1d 1h 0m"], ["Queued", "2h 20m"], ["Sign-off", "2h 30m"], ["Needs input", "0h 45m"], ["In review", "3h 0m"], ["Waiting on a person", "6h 15m"]]) {
      assert.match(html, new RegExp(`<dt>${dt}</dt><dd>${dd}</dd>`), dt);
    }
    assert.match(html, /No stage has run yet/);
  });

  test("shows each stage's time and attempts, and an unknown total when the issue's creation isn't known", () => {
    const html = section(runDetailPage(detail({
      totalMs: null, queuedMs: 0, waiting: { signOffMs: 0, needsInputMs: 0, inReviewMs: 0, totalMs: 0 },
      stages: [{ stageId: "red", ms: 25 * M, attempts: 2 }, { stageId: "green", ms: 95 * M, attempts: 1 }],
    }), null));
    assert.match(html, /<dt>Total<\/dt><dd>not known yet<\/dd>/);
    assert.match(html, /<tr><td>red<\/td><td>0h 25m<\/td><td>2<\/td><\/tr><tr><td>green<\/td><td>1h 35m<\/td><td>1<\/td><\/tr>/);
  });

  test("leaves the section out without durations", () => {
    assert.doesNotMatch(runDetailPage(detail(), null), /<h2>Time<\/h2>/);
  });
});
