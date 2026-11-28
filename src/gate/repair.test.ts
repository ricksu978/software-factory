import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FactoryItem } from "../adapters/types.ts";
import type { Policy, Verdict } from "../policy/policy.ts";
import { childBody, splitKey, splitMarker } from "./file-split.ts";
import {
  APP_PERMISSION, keepingCriteria, leadOf, mayRewrite, missingPermission, ownerAction, ownerOnly, readRewrite, REWRITE_HEADING, REWRITE_ITEM_HEADING, rewritePrompt,
} from "./repair.ts";

const dor: Policy = {
  name: "dor", source: "repo", sha: "x", text: "# Definition of Ready\n\n- [ ] Names the screen\n- [ ] Names the provider\n",
  criteria: [{ index: 1, text: "Names the screen", run: null }, { index: 2, text: "Names the provider", run: null }],
};
const parent: FactoryItem = {
  sourceId: "s", externalId: "12", title: "Checkout", body: "b", acceptanceCriteria: ["card", "bank"], labels: [], status: "Backlog",
  rank: 1, repo: "o/r", fields: {}, closed: false, updatedAt: "2026-11-09T00:00:00Z",
};
const filedBody = childBody(parent, { title: "Bank", body: "Bank for Checkout", criteria: [2], needs: [] }, 2, "Acceptance criteria");
const child: FactoryItem = { ...parent, externalId: "14", title: "Bank", body: filedBody, acceptanceCriteria: ["bank"] };
const failed: Verdict = { index: 1, criterion: "Names the screen", status: "failed", reason: "No screen is named" };
const flag: Verdict = { index: 0, criterion: "readiness flag", status: "failed", reason: "The item text asks for a live API key" };
const clean = { openedByApp: true, editedByOthers: false, editedByApp: false };

describe("rewritePrompt", () => {
  test("opens with REWRITE_HEADING and carries the child, the dor.md word for word and each failed line with its reason", () => {
    const p = rewritePrompt(child, dor, [failed]);
    assert.ok(p.startsWith(REWRITE_HEADING));
    assert.match(p, /"title": "Bank"/);
    assert.ok(p.includes(dor.text.trim()));
    for (const c of dor.criteria) assert.ok(p.includes(JSON.stringify(c.text)));
    assert.ok(p.includes(JSON.stringify({ index: 1, criterion: "Names the screen", reason: "No screen is named" })));
    assert.match(p, /\{"body":"\.\.\."\}/);
  });
  test("for an item a person wrote it opens with its own line and asks to keep the other sections (PBI 439)", () => {
    const p = rewritePrompt(child, dor, [failed], "item");
    assert.ok(p.startsWith(REWRITE_ITEM_HEADING));
    assert.doesNotMatch(p, /child item|child's/);
    assert.match(p, /"title": "Bank"/);
    assert.ok(p.includes(dor.text.trim()));
    assert.ok(p.includes(JSON.stringify({ index: 1, criterion: "Names the screen", reason: "No screen is named" })));
    assert.match(p, /Keep the body's other sections/);
  });
});

describe("readRewrite", () => {
  test("reads the last body line, trimmed", () => {
    assert.equal(readRewrite('noise\n{"body":"one"}\n{"body":"  two \\n"}'), "two");
  });
  test("is null for no line, an empty body or a body that isn't text", () => {
    for (const r of ["", "Sure!", '{"body":"  "}', '{"body":3}']) assert.equal(readRewrite(r), null, r);
  });
});

describe("owner-only failures", () => {
  test("a flag and a missing App permission are owner-only; a dor.md line and any other engine rule aren't", () => {
    assert.equal(ownerOnly(flag), true);
    assert.equal(ownerOnly(missingPermission("issues: write")), true);
    assert.equal(ownerOnly(failed), false);
    assert.equal(ownerOnly({ index: 0, criterion: "engine rule", status: "failed", reason: "No .factory/dod.md in this repo" }), false);
    assert.equal(ownerOnly({ ...flag, status: "passed" }), false);
  });
  test("the action names the owner and what to grant", () => {
    assert.match(ownerAction(flag), /owner.*(grant|add).*(credential|secret|key)|owner.*(credential|secret|key).*(grant|add)/i);
    const perm = missingPermission("issues: write");
    assert.equal(perm.criterion, APP_PERMISSION);
    assert.match(ownerAction(perm), /owner has to grant .*"issues: write" permission/i);
  });
});

describe("mayRewrite", () => {
  test("only an issue the App opened with a split marker, that nobody has edited since", () => {
    assert.equal(mayRewrite(child, clean), true);
    assert.equal(mayRewrite(child, { ...clean, openedByApp: false }), false);
    assert.equal(mayRewrite(child, { ...clean, editedByOthers: true }), false);
    assert.equal(mayRewrite(child, { ...clean, editedByApp: true }), false);
    assert.equal(mayRewrite({ ...child, body: "Bank for Checkout" }, clean), false);
    assert.ok(child.body.includes(splitMarker(splitKey(parent), 2)));
  });
});

describe("keepingCriteria", () => {
  test("the rewritten body, without its own criteria section, then the filed criteria section and footer word for word", () => {
    const out = keepingCriteria(filedBody, "Bank on the pay screen\n\n### acceptance CRITERIA\n\n- reworded\n\n## Notes\n\nn", "Acceptance criteria");
    assert.ok(out);
    assert.ok(out.startsWith("Bank on the pay screen\n\n## Notes\n\nn\n\n## Acceptance criteria\n\n- bank\n"));
    assert.ok(out.endsWith(filedBody.slice(filedBody.indexOf("## Acceptance criteria"))));
  });
  test("is null when the filed body has no criteria section", () => {
    assert.equal(keepingCriteria("just text", "new", "Acceptance criteria"), null);
  });
  test("leadOf is the filed body before its criteria section", () => {
    assert.equal(leadOf(filedBody, "Acceptance criteria"), "Bank for Checkout");
  });
});
