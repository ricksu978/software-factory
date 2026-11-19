// Step definitions for features/pbi-285-api-raw-path-guard.feature. They build on PBI 284's: the same fake issuer,
// the same API started from src/api/main.ts's startApi on port 7402, the same fresh database and the same people.
// PBI 284's hooks run for @pbi-285 too, so the API and the issuer stop after each scenario.
//
// "Sent exactly as written" goes out through node:http with the path untouched. fetch would parse the URL first,
// resolving dot segments and so tidying the very path the scenario is about. In a path, a segment that is exactly an
// item's name is swapped for the item's id, so "/v1/items/%2e/A/decisions" names item A's id after the "%2e".
//
// "Refuses it as a bad path" is a 400 whose JSON error says "bad path", as src/api/main.ts's guard answers.
import { Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { request } from "node:http";
import { ctx, itemId, PORT, validToken, WEBHOOK_SECRET, type Ctx, type Reply } from "./pbi-284.steps.ts";
import { long } from "./pbi-8.steps.ts";

/** `path` with each segment that names one of the scenario's items swapped for the item's id. */
function withIds(c: Ctx, path: string): string {
  return path.split("/").map((segment) => (c.items.has(segment) ? itemId(c, segment) : segment)).join("/");
}

/** Sends `method path` to the API with the path byte for byte as given, and keeps the reply as PBI 284's steps do. */
async function sendRaw(world: object, method: string, path: string, headers: Record<string, string>, body?: Buffer): Promise<void> {
  const c = ctx(world);
  c.reply = await new Promise<Reply>((resolve) => {
    const req = request({ host: "127.0.0.1", port: PORT, method, path, headers: { ...headers, ...(body ? { "content-length": String(body.length) } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? null, text, json });
      });
      res.on("error", (e) => resolve({ status: null, text: "", error: String(e) }));
    });
    // Nothing answered. The Then that reads the reply fails on it.
    req.on("error", (e) => resolve({ status: null, text: "", error: String(e) }));
    req.setTimeout(30_000, () => req.destroy(new Error("the API didn't answer within 30 seconds")));
    req.end(body);
  });
}

async function asJson(world: object, name: string, method: string, path: string, payload?: unknown): Promise<void> {
  const c = ctx(world);
  const headers: Record<string, string> = { authorization: `Bearer ${await validToken(c, name)}` };
  if (payload === undefined) return sendRaw(world, method, withIds(c, path), headers);
  headers["content-type"] = "application/json";
  return sendRaw(world, method, withIds(c, path), headers, Buffer.from(JSON.stringify(payload)));
}

When("{string} signs off item {string} along {string} sent exactly as written, with a valid token", long,
  async function (name: string, item: string, path: string) {
    itemId(ctx(this), item);
    await asJson(this, name, "POST", path, { kind: "approve", text: "" });
  });

When("{string} asks for {string} sent exactly as written, with a valid token", long, async function (name: string, text: string) {
  const [method, path] = text.split(" ");
  await asJson(this, name, method, path);
});

When("{string} pauses the factory with reason {string} along {string} sent exactly as written, with a valid token", long,
  async function (name: string, reason: string, path: string) {
    await asJson(this, name, "POST", path, { kind: "pause", reason });
  });

When("GitHub delivers a comment webhook along {string} sent exactly as written, signed with the webhook secret", long,
  async function (path: string) {
    const c = ctx(this);
    c.delivery = randomUUID();
    const body = Buffer.from(JSON.stringify({
      action: "created", repository: { full_name: "octo/repo" }, issue: { number: 285 },
      comment: { id: 2850, body: "Looks good.", user: { login: "someone", type: "User" } },
    }));
    await sendRaw(this, "POST", path, {
      "content-type": "application/json", "x-github-event": "issue_comment", "x-github-delivery": c.delivery,
      "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`,
    }, body);
  });

Then("the API refuses it as a bad path", function () {
  const c = ctx(this);
  assert.ok(c.started, "the API wasn't started");
  assert.ok(!c.startError, `the API didn't start: ${String((c.startError as Error)?.message ?? c.startError)}`);
  const r = c.reply;
  assert.ok(r, "nothing was asked of the API");
  const said = `${r.status ?? r.error}: ${r.text.slice(0, 300)}`;
  assert.equal(r.status, 400, `the API answered ${said}`);
  const error = (r.json as { error?: unknown } | undefined)?.error;
  assert.match(String(error), /bad path/i, `the API's 400 doesn't say the path is bad: ${said}`);
});
