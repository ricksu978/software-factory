import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, itemDurations, type Move } from "./durations.ts";

const t = (hm: string, day = 10) => new Date(`2026-11-${day}T${hm}:00Z`);
const M = 60_000;
const move = (from: Move["from"], to: Move["to"], at: string): Move => ({ from, to, at: t(at) });
const base = { createdAt: t("09:00"), moves: [] as Move[], stages: [], questions: [] };

test("formats hours and minutes, dropping seconds", () => {
  assert.equal(formatDuration(0), "0h 0m");
  assert.equal(formatDuration(59_000), "0h 0m");
  assert.equal(formatDuration(25 * M), "0h 25m");
  assert.equal(formatDuration((6 * 60 + 45) * M + 59_000), "6h 45m");
  assert.equal(formatDuration((23 * 60 + 59) * M), "23h 59m");
});

test("formats days only once a duration passes 24 hours", () => {
  assert.equal(formatDuration(24 * 60 * M), "24h 0m");
  assert.equal(formatDuration((24 * 60 + 1) * M), "1d 0h 1m");
  assert.equal(formatDuration(((2 * 24 + 3) * 60 + 15) * M), "2d 3h 15m");
  assert.equal(formatDuration(12 * 24 * 60 * M + 1_000), "12d 0h 0m");
});

test("a negative duration reads as none", () => assert.equal(formatDuration(-5 * M), "0h 0m"));

test("the total of an ended item stops at its last move into the end state", () => {
  const d = itemDurations({ ...base, state: "Done", now: t("08:00", 12), moves: [move("InProgress", "Accepted", "15:45"), move("Accepted", "Done", "15:45")] });
  assert.equal(d.totalMs, (6 * 60 + 45) * M);
});

test("an open item's total runs up to now, even after an earlier Failed", () => {
  const d = itemDurations({ ...base, state: "InProgress", now: t("12:30"), moves: [move("InProgress", "Failed", "10:00"), move("Failed", "Queued", "11:00"), move("Queued", "InProgress", "11:00")] });
  assert.equal(d.totalMs, 3.5 * 60 * M);
});

test("with no issue creation time, the total is null", () => {
  assert.equal(itemDurations({ ...base, createdAt: null, state: "InProgress", now: t("12:00") }).totalMs, null);
});

test("every spell Queued and InReview counts, an open last one up to now", () => {
  const d = itemDurations({
    ...base, state: "InReview", now: t("14:50"),
    moves: [
      move("Eligible", "Queued", "09:05"), move("Queued", "InProgress", "09:35"), move("InProgress", "InReview", "13:00"),
      move("InReview", "Queued", "13:40"), move("Queued", "InProgress", "13:40"), move("InProgress", "InReview", "14:00"),
    ],
  });
  assert.equal(d.queuedMs, 30 * M);
  assert.equal(d.waiting.inReviewMs, 90 * M);
});

test("an ended item's last spell isn't counted up to now", () => {
  const d = itemDurations({ ...base, state: "Done", now: t("08:00", 12), moves: [move("InProgress", "InReview", "14:00"), move("InReview", "Accepted", "17:00"), move("Accepted", "Done", "17:00")] });
  assert.equal(d.waiting.inReviewMs, 180 * M);
});

test("moves are taken in time order", () => {
  const d = itemDurations({ ...base, state: "InProgress", now: t("12:00"), moves: [move("Queued", "InProgress", "10:00"), move("Eligible", "Queued", "09:00")] });
  assert.equal(d.queuedMs, 60 * M);
});

test("questions count from asked to answered, closed or now, by kind, and add up with review", () => {
  const d = itemDurations({
    ...base, state: "InProgress", now: t("15:00"),
    moves: [move("InProgress", "InReview", "13:00"), move("InReview", "Queued", "14:00"), move("Queued", "InProgress", "14:00")],
    questions: [
      { kind: "sign_off", askedAt: t("10:00"), answeredAt: t("11:00"), closedAt: null },
      { kind: "sign_off", askedAt: t("11:30"), answeredAt: t("12:00"), closedAt: null },
      { kind: "needs_input", askedAt: t("12:00"), answeredAt: null, closedAt: t("12:40") },
      { kind: "needs_input", askedAt: t("14:00"), answeredAt: null, closedAt: null },
    ],
  });
  assert.equal(d.waiting.signOffMs, 90 * M);
  assert.equal(d.waiting.needsInputMs, 100 * M);
  assert.equal(d.waiting.inReviewMs, 60 * M);
  assert.equal(d.waiting.totalMs, 250 * M);
});

test("stages sum their attempts across runs, a running one up to now, in the order they first started", () => {
  const d = itemDurations({
    ...base, state: "InProgress", now: t("14:30"),
    stages: [
      { stageId: "green", startedAt: t("10:15"), endedAt: t("10:45") },
      { stageId: "red", startedAt: t("10:00"), endedAt: t("10:15") },
      { stageId: "red", startedAt: t("14:00"), endedAt: null },
    ],
  });
  assert.deepEqual(d.stages, [{ stageId: "red", ms: 45 * M, attempts: 2 }, { stageId: "green", ms: 30 * M, attempts: 1 }]);
});

test("moves at the same instant follow their chain, whatever order they're read in", () => {
  const d = itemDurations({
    ...base, state: "InProgress", now: t("18:00"),
    moves: [move("Queued", "InProgress", "17:00"), move("InReview", "Queued", "17:00"), move("InProgress", "InReview", "14:00")],
  });
  assert.equal(d.waiting.inReviewMs, 180 * M);
  assert.equal(d.queuedMs, 0);
});

test("a closed spell counts as logged, and only an ended item's end cuts an open one short", () => {
  const q = { kind: "needs_input" as const, askedAt: t("10:00"), answeredAt: t("12:00"), closedAt: null };
  assert.equal(itemDurations({ ...base, state: "InProgress", now: t("11:00"), questions: [q] }).waiting.needsInputMs, 120 * M);
  const open = { ...q, answeredAt: null };
  const done = itemDurations({ ...base, state: "Abandoned", now: t("15:00"), moves: [move("NeedsInput", "Abandoned", "11:30")], questions: [open] });
  assert.equal(done.waiting.needsInputMs, 90 * M);
});
