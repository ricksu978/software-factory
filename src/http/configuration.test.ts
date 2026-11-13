import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkChange, envSettings, type RuntimeValues } from "./configuration.ts";

const policy: RuntimeValues = {
  mode: "fixed", wip_min: "1", wip_max: "3", current_wip: "1", review_capacity: "3", usage_reserve: "0.7", daily_budget: "25", usage_pause: null,
};

const why = "Two more reviewers are in.";

describe("checkChange", () => {
  test("takes a change that keeps every rule, with its reason trimmed", () => {
    assert.deepEqual(checkChange(policy, "review_capacity", "5", ` ${why} `), { ok: true, reason: why, updates: [{ key: "review_capacity", column: "review_capacity", value: 5 }] });
    assert.deepEqual(checkChange(policy, "usage_reserve", "0.8", why), { ok: true, reason: why, updates: [{ key: "usage_reserve", column: "usage_reserve_at", value: 0.8 }] });
    assert.deepEqual(checkChange(policy, "current_wip", "3", why), { ok: true, reason: why, updates: [{ key: "current_wip", column: "current_wip", value: 3 }] });
  });

  test("takes a usage reserve at either end of 0 to 1", () => {
    for (const [raw, value] of [["0", 0], ["1", 1], ["1.0", 1], [".5", 0.5]] as const) {
      const c = checkChange(policy, "usage_reserve", raw, why);
      assert.ok(c.ok, raw);
      assert.equal(c.updates[0].value, value);
    }
  });

  test("clears the daily budget on an empty value", () => {
    assert.deepEqual(checkChange(policy, "daily_budget", " ", why), { ok: true, reason: why, updates: [{ key: "daily_budget", column: "daily_budget", value: null }] });
  });

  test("turns down a change with no reason, or one of only spaces", () => {
    for (const reason of [undefined, "", "   \n\t"]) {
      const c = checkChange(policy, "review_capacity", "5", reason);
      assert.ok(!c.ok, JSON.stringify(reason));
      assert.equal(c.status, 400);
      assert.equal(c.message, "Give a reason for the change.");
    }
  });

  test("names the broken rule before a missing reason", () => {
    const c = checkChange(policy, "review_capacity", "0");
    assert.ok(!c.ok && c.message === "Review capacity must be a whole number of at least 1.");
  });

  test("moves the current WIP into a new WIP range", () => {
    const raised = checkChange(policy, "wip_min", "2", why);
    assert.ok(raised.ok);
    assert.deepEqual(raised.updates.map((u) => [u.key, u.value]), [["wip_min", 2], ["current_wip", 2]]);
    const lowered = checkChange({ ...policy, current_wip: "3" }, "wip_max", "2", why);
    assert.ok(lowered.ok);
    assert.deepEqual(lowered.updates.map((u) => [u.key, u.value]), [["wip_max", 2], ["current_wip", 2]]);
  });

  test("turns down a value that breaks a rule, with the rule", () => {
    const message = (key: string, value: string) => {
      const c = checkChange(policy, key, value, why);
      assert.ok(!c.ok, `${key}=${value} was taken`);
      assert.equal(c.status, 400);
      return c.message;
    };
    assert.equal(message("wip_min", "0"), "WIP minimum must be a whole number of at least 1.");
    assert.equal(message("wip_min", "4"), "WIP minimum can't be more than WIP maximum.");
    assert.equal(message("wip_max", "2.5"), "WIP maximum must be a whole number of at least 1.");
    assert.equal(message("current_wip", "5"), "Current WIP must be a whole number from WIP minimum to WIP maximum.");
    assert.equal(message("review_capacity", "many"), "Review capacity must be a whole number of at least 1.");
    assert.equal(message("review_capacity", "99999999999"), "Review capacity must be a whole number of at least 1.");
    assert.equal(message("current_wip", "1.5"), "Current WIP must be a whole number from WIP minimum to WIP maximum.");
    assert.equal(message("current_wip", "-1"), "Current WIP must be a whole number from WIP minimum to WIP maximum.");
    assert.equal(message("review_capacity", "-2"), "Review capacity must be a whole number of at least 1.");
    for (const v of ["1.5", "1.01", "-0.1", "half", ""]) assert.equal(message("usage_reserve", v), "Usage reserve must be a number from 0 to 1.");
    assert.equal(message("daily_budget", "-10"), "Daily budget must be more than 0, or left empty for none.");
  });

  test("refuses a setting the factory sets itself, an env-backed one and an unknown one", () => {
    for (const key of ["mode", "usage_pause", "GITHUB_APP_ID", "nope"]) {
      const c = checkChange(policy, key, "1", why);
      assert.ok(!c.ok && c.message === "That setting can't be changed from the page.", key);
    }
  });
});

describe("envSettings", () => {
  test("lists the non-secret settings, with an unset or empty one as null, and never a secret", () => {
    const env = {
      FACTORY_ENV: "local", FACTORY_KILL: "", GITHUB_APP_ID: "123456",
      GITHUB_APP_KEY: "k", GITHUB_PROJECT_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "o", FACTORY_DB_URI: "u", FACTORY_BLOB: "b", CELL_SECRET: "c", GITHUB_WEBHOOK_SECRET: "w",
    };
    const shown = envSettings(env);
    assert.equal(shown.find((s) => s.key === "FACTORY_ENV")?.value, "local");
    assert.equal(shown.find((s) => s.key === "GITHUB_APP_ID")?.value, "123456");
    assert.equal(shown.find((s) => s.key === "FACTORY_KILL")?.value, null);
    assert.equal(shown.find((s) => s.key === "CELL_BLOB_HOST")?.value, null);
    for (const secret of ["GITHUB_APP_KEY", "GITHUB_PROJECT_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "FACTORY_DB_URI", "FACTORY_BLOB", "CELL_SECRET", "GITHUB_WEBHOOK_SECRET"]) {
      assert.ok(!shown.some((s) => s.key === secret), secret);
    }
  });
});
