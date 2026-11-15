import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { hashSessionId, newSessionId, open, openRefreshToken, readSessionKey, seal, sealRefreshToken } from "./session.ts";

const key = () => randomBytes(32).toString("base64");

test("a sealed refresh token opens under the same key and doesn't hold the token", () => {
  const k = key();
  const sealed = sealRefreshToken(k, "rt-alice-1");
  assert.ok(!sealed.includes("rt-alice-1"));
  assert.ok(!sealed.includes(Buffer.from("rt-alice-1").toString("base64")));
  assert.equal(openRefreshToken(k, sealed), "rt-alice-1");
});

test("sealing the same token twice gives different text", () => {
  const k = key();
  assert.notEqual(sealRefreshToken(k, "rt"), sealRefreshToken(k, "rt"));
});

test("a sealed refresh token doesn't open under another key", () => {
  const sealed = sealRefreshToken(key(), "rt-alice-1");
  assert.throws(() => openRefreshToken(key(), sealed));
});

test("a tampered sealed refresh token doesn't open", () => {
  const k = key();
  const sealed = sealRefreshToken(k, "rt-alice-1");
  const last = sealed.at(-1) === "A" ? "B" : "A";
  assert.throws(() => openRefreshToken(k, sealed.slice(0, -1) + last));
  assert.throws(() => openRefreshToken(k, "not sealed"));
});

test("a sealed refresh token whose last character differs only in spare bits doesn't open", () => {
  const k = key();
  const sealed = sealRefreshToken(k, "rt-alice-1");
  // 38 bytes make 51 characters, and the last one carries two bits that decode to nothing.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const i = alphabet.indexOf(sealed.at(-1)!);
  const twin = sealed.slice(0, -1) + alphabet[i ^ 1];
  assert.deepEqual(Buffer.from(twin, "base64url"), Buffer.from(sealed, "base64url"));
  assert.throws(() => openRefreshToken(k, twin));
});

test("text sealed for one purpose doesn't open for another", () => {
  const k = readSessionKey(key());
  assert.equal(open(k, "signin", seal(k, "signin", "x")), "x");
  assert.throws(() => open(k, "refresh-token", seal(k, "signin", "x")));
});

test("the session key must be 32 bytes in base64, and an error names BFF_SESSION_KEY", () => {
  assert.equal(readSessionKey(key()).length, 32);
  assert.throws(() => readSessionKey(undefined), /BFF_SESSION_KEY/);
  assert.throws(() => readSessionKey(""), /BFF_SESSION_KEY/);
  assert.throws(() => readSessionKey(randomBytes(16).toString("base64")), /BFF_SESSION_KEY/);
});

test("session ids are random, and only their hash is kept", () => {
  const a = newSessionId();
  assert.notEqual(a, newSessionId());
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.match(hashSessionId(a), /^[0-9a-f]{64}$/);
  assert.equal(hashSessionId(a), hashSessionId(a));
  assert.ok(!hashSessionId(a).includes(a));
});
