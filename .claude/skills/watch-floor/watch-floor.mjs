// Polls the factory's Floor and prints one digest line whenever it changes. Signs in with the dev-login token from
// `aspire logs control`, and reads it again when the dashboard answers 401, since a restart rotates it.
// Run: node watch-floor.mjs            (watch)
//      node watch-floor.mjs --selftest (check the parser)
import { execSync } from "node:child_process";

const BASE = process.env.FLOOR_URL ?? "http://localhost:7400";
const POLL_MS = 30_000;

const strip = (s) => s.replace(/<[^>]*>/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const between = (html, from, to) => {
  const i = html.indexOf(from);
  if (i < 0) return "";
  const j = html.indexOf(to, i + from.length);
  return html.slice(i + from.length, j < 0 ? undefined : j);
};

/** The Floor reduced to what the watch acts on. Markup: src/http/views.ts, floorPage. */
export function digest(floor, config = "") {
  const status = strip(between(floor, "<h1>Floor</h1>", " waiting. <a")).replace(/\d+ of \d+$/, "").trim();
  const waiting = [...between(floor, "<h2>Waiting on you</h2>", "<h2>").matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, li]) => {
    const n = li.match(/issues\/(\d+)/)?.[1];
    const item = li.match(/\/items\/([0-9a-f-]{36})/)?.[1];
    const pr = li.match(/pull\/(\d+)/)?.[1];
    const state = li.match(/<span class="muted">(\w+), waiting/)?.[1];
    return `#${n} ${state}${pr ? ` pr=#${pr}` : ""} item=${item}`;
  });
  const running = [...between(floor, "<h2>In flight</h2>", "</table>").matchAll(/<tr><td>[\s\S]*?issues\/(\d+)[\s\S]*?<\/td><td>(\w+)<\/td><td>([\s\S]*?)<\/td>/g)]
    .map(([, n, state, stage]) => `#${n} ${state}/${strip(stage)}`);
  const pause = strip(config).match(/usage pause (\S+)/)?.[1];
  return [
    status && `status: ${status}`,
    `waiting: ${waiting.join("; ") || "none"}`,
    `running: ${running.join("; ") || "none"}`,
    pause && pause !== "not" && `usage pause until ${pause}`,
  ].filter(Boolean).join(" | ");
}

function token() {
  const log = execSync("aspire logs control -n 400", { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] });
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
  const floor = `<h1>Floor</h1><p class="banner" role="status">Drain done. Reason: r</p>
<p>2 of 4 waiting. <a href="/activity">Activity</a></p>
<h2>Waiting on you</h2>
<ol><li><a href="https://github.com/o/r/issues/319">#319</a> <a href="/items/5de6c0b0-64bc-4496-9504-21ee32a2c907">Effort</a> <a href="https://github.com/o/r/pull/415">PR #415</a> <span class="muted">InReview, waiting 3 min</span></li><li><a href="https://github.com/o/r/issues/283">#283</a> <a href="/items/0c8e162a-ad76-457b-ac4b-4b6b08ddb767">Keycloak</a> <span class="muted">SignOff, waiting 0 min</span></li></ol>
<h2>Next up</h2><p class="muted">Nothing is ready to start.</p>
<h2>In flight</h2><table><thead><tr><th>Item</th></tr></thead><tbody>
<tr><td><a href="https://github.com/o/r/issues/280">#280</a> <a href="/items/d9b532d1-bd18-4664-81ba-533d19ce3d13">Live</a></td><td>InProgress</td><td>red</td><td>4 min</td><td>$1</td><td class="muted"></td></tr>
</tbody></table>`;
  const got = digest(floor, "<td>usage pause</td><td>2026-11-26T23:00:00Z</td>");
  const want = "status: Drain done. Reason: r | waiting: #319 InReview pr=#415 item=5de6c0b0-64bc-4496-9504-21ee32a2c907; "
    + "#283 SignOff item=0c8e162a-ad76-457b-ac4b-4b6b08ddb767 | running: #280 InProgress/red | usage pause until 2026-11-26T23:00:00Z";
  if (got !== want) { console.error(`selftest failed\n got: ${got}\nwant: ${want}`); process.exit(1); }
  const quiet = digest(`<h1>Floor</h1><p>0 of 4 waiting. <a>x</a></p><h2>Waiting on you</h2><p class="muted">Nothing waits on you.</p><h2>Next up</h2><h2>In flight</h2><p class="muted">No item is in flight.</p>`, "usage pause not set");
  if (quiet !== "waiting: none | running: none") { console.error(`selftest failed on a quiet Floor: ${quiet}`); process.exit(1); }
  console.log("selftest passed");
}

if (process.argv.includes("--selftest")) selftest();
else await watch();
