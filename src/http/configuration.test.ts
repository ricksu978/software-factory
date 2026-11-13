import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkChange, envSettings, type RuntimeValues } from "./configuration.ts";

const policy: RuntimeValues = {
  mode: "fixed", wip_min: "1", wip_max: "3", current_wip: "1", review_capacity: "3", usage_reserve: "0.7", daily_budget: "25", usage_pause: null,
};

describe("checkChange", () => {
  test("takes a change that keeps every rule", () => {
    assert.deepEqual(checkChange(policy, "review_capacity", "5"), { ok: true, updates: [{ key: "review_capacity", column: "review_capacity", value: 5 }] });
    assert.deepEqual(checkChange(policy, "usage_reserve", "0.8"), { ok: true, updates: [{ key: "usage_reserve", column: "usage_reserve_at", value: 0.8 }] });
    assert.deepEqual(checkChange(policy, "current_wip", "3"), { ok: true, updates: [{ key: "current_wip", column: "current_wip", value: 3 }] });
  });

  test("clears the daily budget on an empty value", () => {
    assert.deepEqual(checkChange(policy, "daily_budget", " "), { ok: true, updates: [{ key: "daily_budget", column: "daily_budget", value: null }] });
  });

  test("moves the current WIP into a new WIP range", () => {
    const raised = checkChange(policy, "wip_min", "2");
    assert.ok(raised.ok);
    assert.deepEqual(raised.updates.map((u) => [u.key, u.value]), [["wip_min", 2], ["current_wip", 2]]);
    const lowered = checkChange({ ...policy, current_wip: "3" }, "wip_max", "2");
    assert.ok(lowered.ok);
    assert.deepEqual(lowered.updates.map((u) => [u.key, u.value]), [["wip_max", 2], ["current_wip", 2]]);
  });

  test("turns down a value that breaks a rule, with the rule", () => {
    const message = (key: string, value: string) => {
      const c = checkChange(policy, key, value);
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
    assert.equal(message("usage_reserve", "1.5"), "Usage reserve must be more than 0 and at most 1.");
    assert.equal(message("usage_reserve", "0"), "Usage reserve must be more than 0 and at most 1.");
    assert.equal(message("usage_reserve", ""), "Usage reserve must be more than 0 and at most 1.");
    assert.equal(message("daily_budget", "-10"), "Daily budget must be more than 0, or left empty for none.");
  });

  test("refuses a setting the factory sets itself, an env-backed one and an unknown one", () => {
    for (const key of ["mode", "usage_pause", "GITHUB_APP_ID", "nope"]) {
      const c = checkChange(policy, key, "1");
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
