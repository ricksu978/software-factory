import assert from "node:assert/strict";
import { test } from "node:test";
import { canAssign, serialLast } from "./parallel.ts";

const p = (...tags: string[]) => ({ tags: tags.map((name) => ({ name })) });

test("a scenario without @serial shares the machine with others without it", () => {
  assert.equal(canAssign(p(), []), true);
  assert.equal(canAssign(p("@db"), [p(), p("@pbi-1")]), true);
});

test("a @serial scenario starts only when nothing else runs", () => {
  assert.equal(canAssign(p("@serial"), []), true);
  assert.equal(canAssign(p("@serial"), [p()]), false);
  assert.equal(canAssign(p("@serial"), [p("@serial")]), false);
});

test("no scenario starts while a @serial one runs", () => {
  assert.equal(canAssign(p(), [p("@serial")]), false);
  assert.equal(canAssign(p("@db"), [p(), p("@local", "@serial")]), false);
});

test("the @serial scenarios go to the end of the queue, and every scenario keeps its order among its kind", () => {
  const q = [
    { id: "a", pickle: p("@serial") },
    { id: "b", pickle: p() },
    { id: "c", pickle: p("@serial", "@local") },
    { id: "d", pickle: p("@db") },
  ];
  assert.deepEqual(serialLast(q).map((x) => x.id), ["b", "d", "a", "c"]);
  assert.deepEqual(q.map((x) => x.id), ["a", "b", "c", "d"], "the queue it was given is left as it was");
});
