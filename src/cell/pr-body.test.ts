import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cleanSummary } from "./pr-body.ts";

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
});
