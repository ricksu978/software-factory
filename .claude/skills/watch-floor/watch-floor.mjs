// Polls the factory's Floor and prints one digest line whenever it changes. Signs in with the dev-login token from
// `aspire logs control`, and reads it again when the dashboard answers 401, since a restart rotates it.
// Run from the repo root: node .claude/skills/watch-floor/watch-floor.mjs            (watch)
//                         node .claude/skills/watch-floor/watch-floor.mjs --selftest (check the parser)
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";

const BASE = process.env.FLOOR_URL ?? "http://localhost:7400";
const POLL_MS = 30_000;

const strip = (s) => s.replace(/<[^>]*>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const between = (html, from, to) => {
  const i = html.indexOf(from);
  if (i < 0) return "";
  const j = html.indexOf(to, i + from.length);
  return html.slice(i + from.length, j < 0 ? undefined : j);
};
// An item's number is the leading `#N` of its row, linked or not (issueRef in src/http/views.ts).
const issue = (html) => strip(html).match(/^#(\d+)/)?.[1] ?? "?";
// A Floor list's top-level rows. A NotReady row of Waiting on you nests its failed checks as <li>s, so split where an item starts.
const rows = (section) => section.split(/<li>(?=(?:<a [^>]*>)?#\d)/).slice(1);

/** The Floor reduced to what the watch acts on. Markup: floorPage in src/http/views.ts. */
export function digest(floor, config = "", now = Date.now()) {
  const banners = [...floor.matchAll(/<(p|section)\b[^>]*role="(?:status|alert)"[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => strip(m[2]));
  const waitingRows = rows(between(floor, "<h2>Waiting on you</h2>", "<h2>"));
  // The state leads the row's first muted span; a split child's "part of #N" span comes before it and doesn't match.
  const stateOf = (li) => li.match(/<span class="muted">(\w+)(?:,|<\/span>)/)?.[1];
  const waiting = waitingRows.map((li) => {
    const item = li.match(/\/items\/([0-9a-f-]{36})/)?.[1];
    const pr = li.match(/pull\/(\d+)/)?.[1];
    return `#${issue(li)} ${stateOf(li)}${pr ? ` pr=#${pr}` : ""} item=${item}`;
  });
  const rules = waitingRows.filter((li) => stateOf(li) === "NotReady" && li.includes("waits for the owner to approve")).map((li) => `#${issue(li)}`);
  // Production Line: InProgress rows are in flight, every other row is queued, in claim order.
  const line = [...between(floor, "<h2>Production Line</h2>", "</table>").matchAll(/<tr><td>([\s\S]*?)<\/tr>/g)].map(([, row]) => {
    const [item, state, stage] = row.split(/<\/td>\s*<td[^>]*>/);
    return { n: issue(item), state: strip(state ?? ""), stage: strip(stage ?? "") };
  });
  const inFlight = line.filter((r) => r.state === "InProgress").map((r) => `#${r.n} ${r.state}/${r.stage}`);
  const next = line.filter((r) => r.state !== "InProgress").map((r) => `#${r.n}`);
  const pause = strip(config).match(/usage pause (\S+)/)?.[1];
  const paused = pause && Date.parse(pause) > now; // the column keeps a past pause, which holds nothing (pauseActive)
  return [
    banners.length && `banners: ${banners.join(" / ")}`,
    `waiting: ${waiting.join("; ") || "none"}`,
    `in flight: ${inFlight.join("; ") || "none"}`,
    `next up: ${next.join(" ") || "none"}`,
    rules.length && `rule approval: ${rules.join(" ")}`,
    paused && `usage pause until ${pause}`,
  ].filter(Boolean).join(" | ");
}

// The running AppHost belongs to the main checkout. From a worktree, `aspire` finds none under the current directory
// and fails on a selection prompt it can't show, so name the main checkout's AppHost.
function apphost() {
  const common = execSync("git rev-parse --path-format=absolute --git-common-dir", { encoding: "utf8" }).trim();
  return join(dirname(common), "aspire-apphost");
}

function token() {
  const log = execSync(`aspire logs control --apphost "${apphost()}" --search "dev-login"`, { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] });
  const all = [...log.matchAll(/dev-login\?token=([0-9a-f]+)/g)];
  if (!all.length) throw new Error("no dev-login token in `aspire logs control`");
  return all.at(-1)[1];
}

async function get(path, cookie) {
  const res = await fetch(BASE + path, { headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  if (res.status !== 200) throw Object.assign(new Error(`HTTP ${res.status} on ${path}`), { status: res.status });
  return res.text();
}

async function watch() {
  let cookie = null;
  let last = "";
  const say = (line) => { if (line !== last) { console.log(new Date().toISOString().slice(11, 19), line); last = line; } };
  for (;;) {
    try {
      cookie ??= `factory_dev=${token()}`;
      say(digest(await get("/", cookie), await get("/configuration", cookie)));
    } catch (e) {
      if (e.status === 401) cookie = null; // a restart rotated the token: sign in again next poll
      say(e.status === 401 ? "signed out: reading a new dev-login token" : `factory unreachable: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function selftest() {
  const now = Date.parse("2026-11-26T12:00:00Z");
  const check = (name, got, want) => { if (got !== want) { console.error(`selftest failed: ${name}\n got: ${got}\nwant: ${want}`); process.exit(1); } };
  const floor = `<!doctype html><p class="banner" role="status">Your Claude token expires in 2 days.</p><main><h1>Floor</h1>
<p class="banner" role="status">Drain done. Reason: r.</p><p class="muted">The cell image was built from commit <code>fdd3692</code>.</p>
<p>2 of 4 waiting. <a href="/activity">Activity</a></p>
<h2>Waiting on you</h2>
<ol><li><a href="https://github.com/o/r/issues/319">#319</a> <a href="/items/5de6c0b0-64bc-4496-9504-21ee32a2c907">Effort</a> <span class="muted">InReview, waiting 3 min</span> Waits on your review of <a href="https://github.com/o/r/pull/415">PR #415</a>.</li><li>#283 <a href="/items/0c8e162a-ad76-457b-ac4b-4b6b08ddb767">Keycloak</a> <span class="muted">part of <a href="/items/11111111-1111-4111-8111-111111111111">#280</a></span> <span class="muted">SignOff, waiting 0 min</span> Waits on your sign-off.</li><li><a href="https://github.com/o/r/issues/414">#414</a> <a href="/items/22222222-2222-4222-8222-222222222222">C</a> <span class="muted">NotReady, waiting 1 min</span> Not ready. The readiness gate turned it down, failing:<ul><li>The item waits for the owner to approve its change to spec section §6.</li></ul></li><li>#412 <a href="/items/33333333-3333-4333-8333-333333333333">D</a> <span class="muted">NotReady</span> Not ready. The readiness gate turned it down, failing:<ul><li>An item that changes the rules says so.</li></ul></li></ol>
<h2>Production Line</h2>
<table><thead><tr><th scope="col">Item</th><th scope="col">State</th><th scope="col">Stage</th><th scope="col">In stage</th><th scope="col">Cost</th><th scope="col">Last agent message</th></tr></thead><tbody>
<tr><td>#280 <a href="/items/d9b532d1-bd18-4664-81ba-533d19ce3d13">Live</a> <span class="badge">bug</span></td><td>InProgress</td><td>red</td><td>4 min</td><td title="$1">$1</td><td class="muted"></td></tr>
<tr><td><a href="https://github.com/o/r/issues/418">#418</a> <a href="/items/x">A</a></td><td>Accepted</td><td></td><td></td><td></td><td></td></tr>
<tr><td>#419 <a href="/items/y">B</a> <span class="muted">Waits on #418, which is still open. It starts once it closes.</span></td><td>Accepted</td><td></td><td></td><td></td><td></td></tr>
</tbody></table>
<p class="muted">2 more items are queued.</p>
</main>`;
  const pauseRow = (at) => `<tr><th scope="row">usage pause</th><td>${at}</td><td>Set by the factory</td></tr>`;
  check("busy Floor", digest(floor, pauseRow("2026-11-26T23:00:00Z"), now),
    "banners: Your Claude token expires in 2 days. / Drain done. Reason: r. | "
    + "waiting: #319 InReview pr=#415 item=5de6c0b0-64bc-4496-9504-21ee32a2c907; #283 SignOff item=0c8e162a-ad76-457b-ac4b-4b6b08ddb767; "
    + "#414 NotReady item=22222222-2222-4222-8222-222222222222; #412 NotReady item=33333333-3333-4333-8333-333333333333 | "
    + "in flight: #280 InProgress/red | next up: #418 #419 | rule approval: #414 | usage pause until 2026-11-26T23:00:00Z");
  const quiet = `<main><h1>Floor</h1><p>0 of 4 waiting. <a>x</a></p><h2>Waiting on you</h2><p class="muted">Nothing waits on you.</p><h2>Production Line</h2><p class="muted">Nothing is in production.</p></main>`;
  check("past pause", digest(quiet, pauseRow("2026-11-26T01:00:00Z"), now), "waiting: none | in flight: none | next up: none");
  check("no pause", digest(quiet, pauseRow("not set"), now), "waiting: none | in flight: none | next up: none");
  console.log("selftest passed");
}

if (process.argv.includes("--selftest")) selftest();
else await watch();
