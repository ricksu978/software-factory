import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { BFF_PORT, readSettings } from "./settings.ts";

const env = (over: Record<string, string | undefined> = {}) => ({
  OIDC_ISSUER: "https://idp", OIDC_CLIENT_ID: "dashboard", OIDC_CLIENT_SECRET: "s",
  BFF_SESSION_KEY: randomBytes(32).toString("base64"), ...over,
});

test("the BFF listens on 7403 with its origin there when PORT and BFF_ORIGIN aren't set", () => {
  const s = readSettings(env());
  assert.equal(BFF_PORT, 7403);
  assert.equal(s.port, 7403);
  assert.equal(s.origin, "http://localhost:7403");
  assert.equal(s.scopes, "openid");
});

test("PORT, BFF_ORIGIN and OIDC_SCOPES override the defaults", () => {
  const s = readSettings(env({ PORT: "9001", BFF_ORIGIN: "https://factory.example", OIDC_SCOPES: "openid profile" }));
  assert.equal(s.port, 9001);
  assert.equal(s.origin, "https://factory.example");
  assert.equal(s.scopes, "openid profile");
});

test("a missing session key, issuer or client id is named", () => {
  assert.throws(() => readSettings(env({ BFF_SESSION_KEY: undefined })), /BFF_SESSION_KEY/);
  assert.throws(() => readSettings(env({ OIDC_ISSUER: undefined })), /OIDC_ISSUER/);
  assert.throws(() => readSettings(env({ OIDC_CLIENT_ID: "" })), /OIDC_CLIENT_ID/);
});

test("an empty client secret means a public client", () => {
  assert.equal(readSettings(env({ OIDC_CLIENT_SECRET: undefined })).clientSecret, undefined);
});

test("API_URL is the API's base address, and without it the BFF has no API to forward to", () => {
  assert.equal(readSettings(env({ API_URL: "http://localhost:7400/" })).apiUrl, "http://localhost:7400");
  assert.equal(readSettings(env()).apiUrl, undefined);
  assert.throws(() => readSettings(env({ API_URL: "not a url" })), /API_URL/);
});
