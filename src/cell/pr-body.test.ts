import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cleanSummary, summaryOf } from "./pr-body.ts";

const BODY = "## Problem\n\nOrders over 100 items time out.\n\n## What changes\n\nOrders are saved in batches.";

describe("cleanSummary", () => {
  test("keeps only the contents of one fenced block around the body, with or without a language name", () => {
    for (const open of ["```markdown", "```", "~~~md", "````"]) {
      const close = open.replace(/[a-z]+$/, "");
      assert.deepEqual(cleanSummary(`Here is the PR body:\n\n${open}\n${BODY}\n${close}\n\nLet me know.`), { body: BODY }, open);
    }
  });

  test("drops the text before the first `## ` heading, inside a fence as well", () => {
    assert.deepEqual(cleanSummary(`I've reviewed the diff.\n\nI ran git log.\n\n${BODY}`), { body: BODY });
    assert.deepEqual(cleanSummary(`\`\`\`markdown\nPR body below.\n\n${BODY}\n\`\`\``), { body: BODY });
  });

  test("leaves a code block inside the body alone when a heading sits outside it", () => {
    const body = `${BODY}\n\n\`\`\`ts\nawait saveInBatches(order, 50);\n\`\`\``;
    assert.deepEqual(cleanSummary(`Done.\n\n${body}`), { body });
  });

  test("returns a summary that already starts with `## Problem` unchanged", () => {
    const body = `${BODY}\n\n\`\`\`ts\nawait saveInBatches(order, 50);\n\`\`\``;
    assert.deepEqual(cleanSummary(body), { body });
    assert.deepEqual(cleanSummary('## Problem\n\nThe heading "## Fixes" is missing.'), { body: '## Problem\n\nThe heading "## Fixes" is missing.' });
  });

  test("a summary that doesn't start with a `## Problem` heading after both rules gives a finding", () => {
    for (const text of ["## What changes\n\nBatches.", "I couldn't find anything.", "# Problem\n\nx", "### Problem\n\nx", "## Problems\n\nx", ""]) {
      const r = cleanSummary(text);
      assert.ok("finding" in r, text);
      assert.match(r.finding, /must start with a `## Problem` heading/);
      assert.match(r.finding, /PR body alone, with nothing before or after it/);
    }
  });

  test("the finding names what the reply starts with, in a whole sentence", () => {
    const heading = cleanSummary("## What changes\n\nBatches.");
    assert.ok("finding" in heading);
    assert.match(heading.finding, /and this reply starts with "## What changes"\. Reply with/);
    const none = cleanSummary("I couldn't find anything.");
    assert.ok("finding" in none);
    assert.match(none.finding, /and this reply has no `## ` heading, and starts with "I couldn't find anything\."\. Reply with/);
  });
});

describe("summaryOf", () => {
  test("cleans the text of a call that succeeded", () => {
    assert.deepEqual(summaryOf({ ok: true, text: `Done.\n\n${BODY}` }), { body: BODY });
  });

  test("a failed call's finding says the call failed, not that the body lacked a heading", () => {
    for (const [text, said] of [["API error 529\nretry later", / \("API error 529"\), so it wrote no PR body\./], ["", /failed, so it wrote no PR body\./]] as const) {
      const r = summaryOf({ ok: false, text });
      assert.ok("finding" in r, text);
      assert.match(r.finding, /^The open-pr agent call failed/);
      assert.match(r.finding, said);
      assert.doesNotMatch(r.finding, /heading/);
    }
  });
});
