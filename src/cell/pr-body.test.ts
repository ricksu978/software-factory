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

describe("cleanSummary with code blocks (PBI 291)", () => {
  const CODE = "```ts\nawait saveInBatches(order, 50);\n```";
  const WITH = `${BODY}\n\n${CODE}`;

  test("a markdown, md or bare wrapper keeps the code blocks inside it", () => {
    for (const open of ["```markdown", "```md", "```", "~~~markdown", "````"]) {
      const close = open.replace(/[a-z]+$/, "");
      assert.deepEqual(cleanSummary(`Here it is:\n\n${open}\n${WITH}\n${close}\n\nLet me know.`), { body: WITH }, open);
    }
    const two = `${WITH}\n\nAfter:\n\n\`\`\`\nnpm run lint\n\`\`\``;
    assert.deepEqual(cleanSummary(`\`\`\`markdown\n${two}\n\`\`\``), { body: two });
  });

  test("a body that leaves a code block open gives a finding", () => {
    for (const text of [`${BODY}\n\n\`\`\`ts\nawait x;`, `\`\`\`markdown\n${BODY}\n\n\`\`\`python\nrows\n\`\`\``, `Here:\n\n${BODY}\n\`\`\``]) {
      const r = cleanSummary(text);
      assert.ok("finding" in r, text);
      assert.match(r.finding, /^The PR body leaves a code block open/);
      assert.match(r.finding, /PR body alone, with nothing before or after it/);
    }
  });

  test("a clean body with balanced code blocks is unchanged", () => {
    const body = `${BODY}\n\n\`\`\`\nnpm run lint\n\`\`\`\n\n${CODE}`;
    assert.deepEqual(cleanSummary(body), { body });
  });
});

describe("cleanSummary with a note after the wrapper (PBI 297)", () => {
  const CODE = "```ts\nawait saveInBatches(order, 50);\n```";

  test("a markdown, md or bare wrapper closes at its own fence, leaving out a note and its code block after it", () => {
    for (const open of ["```markdown", "```md", "```", "~~~markdown"]) {
      const close = open.replace(/[a-z]+$/, "");
      for (const note of ["```\nnpm test\n```", "```sh\nnpm test\n```", "```\nnpm ci\n```\n\nThen:\n\n```\nnpm test\n```\n\nLet me know."]) {
        assert.deepEqual(cleanSummary(`Sure.\n\n${open}\n${BODY}\n${close}\n\nTo check it, run:\n\n${note}`), { body: BODY }, `${open} / ${note}`);
      }
    }
  });

  test("a code block inside the wrapper is kept, and the note's code block after it is not", () => {
    const body = `${BODY}\n\n${CODE}`;
    assert.deepEqual(cleanSummary(`\`\`\`markdown\n${body}\n\`\`\`\n\nRun:\n\n\`\`\`\nnpm test\n\`\`\``), { body });
  });

  test("a bare code block inside the wrapper is kept when a heading outside any code block follows it", () => {
    const body = `${BODY}\n\n\`\`\`\nnpm run lint\n\`\`\`\n\n## How to check\n\n\`\`\`ts\nawait x;\n\`\`\`\n\n## Notes\n\nZ.`;
    assert.deepEqual(cleanSummary(`\`\`\`markdown\n${body}\n\`\`\`\n\nRun:\n\n\`\`\`\nnpm test\n\`\`\``), { body });
  });

  test("a `## ` line inside a note's code block is code, so the note is left out", () => {
    const body = "## Problem\n\nX.";
    for (const note of ["```md\n## Testing\n```", "```sh\nnpm run build\n## then lint\nnpm run lint\n```"]) {
      assert.deepEqual(cleanSummary(`\`\`\`markdown\n${body}\n\`\`\`\n\nRun:\n\n${note}`), { body }, note);
    }
  });

  test("a bare code block in the middle of a wrapped body, with more sections after it, is kept whole", () => {
    // Fence, text, fence, `## ` line could also be the wrapper's closing fence and a note whose code block holds a `## `
    // line. A bare code block inside the body is far likelier, so the body reaches the PR whole, as PBI 291 made it.
    const bodies = [
      "## Problem\n\nX.\n\n```\ncode\n```\n\n## Testing\n\nfoo",
      "## Problem\n\nX.\n\n```\ncode\n```\n\nMore text.\n\n## Testing\n\nfoo",
      `${BODY}\n\n\`\`\`\nnpm run lint\n\`\`\`\n\n## How to check\n\nRun the lint.`,
      "## Problem\nx\n```\na\n```\n## What changes\ny",
    ];
    for (const body of bodies) {
      assert.deepEqual(cleanSummary(`Here:\n\n\`\`\`markdown\n${body}\n\`\`\``), { body }, body);
      assert.deepEqual(cleanSummary(`\`\`\`markdown\n${body}\n\`\`\`\n\nRun:\n\n\`\`\`\nnpm test\n\`\`\``), { body }, `${body} / note`);
    }
  });

  test("a fence that could close the wrapper or open a bare block that never closes gives a finding", () => {
    // Read as opening a block, the heading after it counts but the wrapper never closes, so neither guess is safe.
    const r = cleanSummary("```md\n## Problem\n\nX.\n```\n\nRun:\n\n```\n## Testing\n");
    assert.ok("finding" in r);
    assert.match(r.finding, /could close the PR body's wrapper or open a code block inside it/);
    assert.match(r.finding, /PR body alone, with nothing before or after it/);
  });

  test("a bare code block in the last section of a wrapped body, with text after it, is kept whole", () => {
    // The fence after "Run:" is spaced as an opening fence and its block's closing fence as a closing one, so it's a
    // bare block inside the body, not the wrapper's end before a note whose code block holds "Then merge it.".
    const bodies = [
      "## Problem\n\nX.\n\n## What changes\n\nRun:\n\n```\nnpm run lint\n```\n\nThen merge it.",
      "## Problem\n\nX.\n\n## What changes\n\nFirst:\n\n```\nnpm ci\n```\n\nThen:\n\n```\nnpm test\n```\n\nBoth pass.",
      "## Problem\n\nX.\n\n## What changes\n\nY.\n\n```\nnpm run lint\n```\n\nThen merge it.",
    ];
    for (const open of ["```markdown", "```md", "```"]) {
      for (const body of bodies) {
        assert.deepEqual(cleanSummary(`${open}\n${body}\n\`\`\``), { body }, `${open} / ${body}`);
      }
    }
  });

  test("a fence-only line spaced so it could close the wrapper or open a bare block gives a finding", () => {
    // Text right before and right after the fence, or a block whose closing fence has text right after it, reads
    // just as well as the wrapper's end before a note, so neither guess is safe.
    const body = "## Problem\n\nX.\n\n## What changes\n\nY.";
    for (const open of ["```markdown", "```md", "```"]) {
      for (const tail of ["```\nnpm run lint\n```\n\nDone.\n```", "```\nRun:\n```\nnpm test\n```", "```\nRun:\n\n```\nnpm test\n```", "\n```\nI also ran:\n```\nnpm test\n```"]) {
        const r = cleanSummary(`${open}\n${body}\n${tail}`);
        assert.ok("finding" in r, `${open} / ${tail}`);
        assert.match(r.finding, /could close the PR body's wrapper or open a code block inside it/);
        assert.match(r.finding, /not clear where the PR body ends/);
      }
    }
  });

  test("a bare code block right under a heading stays in the body, with the text after it", () => {
    const body = "## Problem\n\nX.\n\n## Testing\n\n```\nnpm run lint\n```\n\nIt passes.";
    for (const open of ["```markdown", "```md", "```"]) {
      assert.deepEqual(cleanSummary(`${open}\n${body}\n\`\`\``), { body }, open);
    }
  });

  test("a note right under the wrapper's closing fence, with no blank line between, is left out when its block can't be the body's", () => {
    const body = "## Problem\n\nX.\n\n## What changes\n\nY.";
    for (const open of ["```markdown", "```md", "```"]) {
      for (const note of ["Run:\n```sh\nnpm test\n```", "Run:\n\n```sh\nnpm test\n```"]) {
        assert.deepEqual(cleanSummary(`${open}\n${body}\n\`\`\`\n${note}`), { body }, `${open} / ${note}`);
      }
    }
  });

  test("the reply from #297's report ends at Fixed it.", () => {
    const body = "## Problem\n\nA stray fence.\n\n## What changes\n\nThe wrapper runs to its own fence.\n\nFixed it.";
    assert.deepEqual(cleanSummary(`\`\`\`markdown\n${body}\n\`\`\`\n\nNote: to check it yourself, run:\n\n\`\`\`\nnpm test -- src/cell/pr-body.test.ts\n\`\`\``), { body });
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
