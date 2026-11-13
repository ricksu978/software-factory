import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cost, localTime, timeSpent, tokens, zoneFrom } from "./format.ts";

describe("tokens (PBI 189)", () => {
  test("a count under 1,000 shows as is", () => {
    for (const [n, want] of [[0, "0"], [640, "640"], [999, "999"]] as const) assert.equal(tokens(n), want);
  });
  test("thousands and millions show to 1 decimal place, rounding half up", () => {
    const cases: [number, string][] = [
      [1000, "1.0k"], [1049, "1.0k"], [1050, "1.1k"], [12750, "12.8k"], [48210, "48.2k"], [999949, "999.9k"],
      [999950, "1.0m"], [1000000, "1.0m"], [1050000, "1.1m"], [2149999, "2.1m"],
    ];
    for (const [n, want] of cases) assert.equal(tokens(n), want, String(n));
  });
});

describe("cost (PBI 189)", () => {
  test("rounds to the cent, half up, from a stored numeric or a number", () => {
    const cases: [string | number, string][] = [
      ["0.5291", "$0.53"], [0.055, "$0.06"], ["0.0550", "$0.06"], [0.005, "$0.01"], [0.0149, "$0.01"], [1.235, "$1.24"], ["1.2350", "$1.24"], ["12.995", "$13.00"], [3, "$3.00"],
    ];
    for (const [v, want] of cases) assert.equal(cost(v), want, String(v));
  });
  test("a cost above zero that rounds to nothing shows <$0.01", () => {
    for (const v of [0.0001, 0.0049, "0.0004", 0.0031, 1e-7]) assert.equal(cost(v), "<$0.01", String(v));
  });
  test("nothing spent shows $0.00", () => {
    for (const v of [0, "0", "0.0000", null]) assert.equal(cost(v), "$0.00", String(v));
  });
});

describe("timeSpent (PBI 189)", () => {
  const at = (iso: string) => new Date(iso);
  const start = at("2026-11-09T10:00:00Z");
  test("under an hour shows minutes and seconds", () => {
    assert.equal(timeSpent(start, at("2026-11-09T10:00:42Z")), "0m 42s");
    assert.equal(timeSpent(start, at("2026-11-09T10:04:07Z")), "4m 7s");
    assert.equal(timeSpent(start, at("2026-11-09T10:59:59Z")), "59m 59s");
  });
  test("an hour or more shows hours and minutes", () => {
    assert.equal(timeSpent(start, at("2026-11-09T11:00:00Z")), "1h 0m");
    assert.equal(timeSpent(start, at("2026-11-09T11:12:20Z")), "1h 12m");
    assert.equal(timeSpent(start, at("2026-11-10T12:05:00Z")), "26h 5m");
  });
  test("an end before the start shows no time spent", () => {
    assert.equal(timeSpent(start, at("2026-11-09T09:59:00Z")), "0m 0s");
  });
});

describe("localTime (PBI 189)", () => {
  test("shows the time to the minute in the zone, with summer time and the zone's own date", () => {
    assert.equal(localTime(new Date("2026-11-09T10:15:00Z"), "UTC"), "2026-11-09 10:15");
    assert.equal(localTime(new Date("2026-11-09T10:15:00Z"), "Europe/Berlin"), "2026-11-09 11:15");
    assert.equal(localTime(new Date("2026-11-09T23:30:00Z"), "Asia/Tokyo"), "2026-11-10 08:30");
    assert.equal(localTime(new Date("2026-07-15T14:00:00Z"), "America/New_York"), "2026-07-15 10:00");
    assert.equal(localTime(new Date("2026-12-15T14:00:00Z"), "America/New_York"), "2026-12-15 09:00");
    assert.equal(localTime(new Date("2026-11-09T10:15:00Z"), "Asia/Kolkata"), "2026-11-09 15:45");
    assert.equal(localTime(new Date("2026-11-09T00:05:00Z"), "UTC"), "2026-11-09 00:05");
  });
});

describe("zoneFrom (PBI 189)", () => {
  test("reads the tz cookie's IANA zone", () => {
    assert.equal(zoneFrom("a=1; tz=Europe%2FBerlin; b=2"), "Europe/Berlin");
    assert.equal(zoneFrom("tz=Asia/Tokyo"), "Asia/Tokyo");
  });
  test("no cookie, or a zone that isn't one, is UTC", () => {
    for (const h of [undefined, "", "tz=", "tz=Not%2FAZone", "tz=%E0%A4%A", "other=Europe/Berlin"]) assert.equal(zoneFrom(h), "UTC", String(h));
  });
});
