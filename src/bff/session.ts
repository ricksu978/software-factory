// The BFF's sessions (redesign step 7a, 2026-11-07 design §04 and §08). The browser holds only the session cookie, a
// random id. The session row in Postgres is keyed by that id's hash and holds the token's issuer and subject, the
// access token, and the refresh token sealed under the session key (BFF_SESSION_KEY, 32 random bytes in base64).
// A session lasts seven days idle and 30 days at most.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type pg from "pg";

/** The name of the session cookie the BFF sets after sign-in and clears at /auth/logout. */
export const SESSION_COOKIE = "factory_session";

export const SESSION_IDLE_SECONDS = 7 * 24 * 3600;
export const SESSION_MAX_SECONDS = 30 * 24 * 3600;

/** The session key from BFF_SESSION_KEY. Throws, naming the setting, unless it is 32 bytes in base64. */
export function readSessionKey(raw: string | undefined): Buffer {
  if (!raw) throw new Error("BFF_SESSION_KEY is not set: it must be 32 random bytes in base64");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`BFF_SESSION_KEY must be 32 bytes in base64, not ${key.length}`);
  return key;
}

/**
 * Seals text under the key with AES-256-GCM. The purpose is bound in as associated data, so text sealed for one use
 * (a refresh token, the sign-in cookie) can't be passed off as another. The result is base64url.
 */
export function seal(key: Buffer, purpose: string, text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(purpose));
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
}

/** Opens text sealed by seal() under the same key and purpose. Throws on any other key, purpose or a changed byte. */
export function open(key: Buffer, purpose: string, sealed: string): string {
  const raw = Buffer.from(sealed, "base64url");
  if (raw.length < 28) throw new Error("the sealed text is too short");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(purpose));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8");
}

/** The purpose refresh tokens are sealed for. */
export const REFRESH_TOKEN = "refresh-token";

/** Seals a refresh token under the session key, for session.refresh_token_encrypted. */
export function sealRefreshToken(key: string, token: string): string {
  return seal(readSessionKey(key), REFRESH_TOKEN, token);
}

/** Opens a refresh token sealed by sealRefreshToken under the same session key, and throws under any other key. */
export function openRefreshToken(key: string, sealed: string): string {
  return open(readSessionKey(key), REFRESH_TOKEN, sealed);
}

/** A new session id for the cookie: 32 random bytes in base64url. */
export function newSessionId(): string {
  return randomBytes(32).toString("base64url");
}

/** The hash a session id is stored under, so the table never holds a live cookie. */
export function hashSessionId(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

export type NewSession = {
  cookieHash: string;
  issuer: string;
  subject: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenEncrypted: string | null;
  expiresAt: Date;
};

export type Who = { issuer: string; subject: string };

/** Where sessions live. The BFF's only reach into the database. */
export type SessionStore = {
  create(s: NewSession): Promise<void>;
  /** The live session under the hash, marking it seen, or null when there is none or it has expired. */
  find(cookieHash: string): Promise<Who | null>;
  remove(cookieHash: string): Promise<void>;
};

/** Sessions in Postgres. The pool is expected to work as factory_bff. */
export function pgSessions(pool: pg.Pool): SessionStore {
  return {
    async create(s) {
      await pool.query(
        `insert into session (cookie_hash, issuer, subject, access_token, access_token_expires_at, refresh_token_encrypted, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [s.cookieHash, s.issuer, s.subject, s.accessToken, s.accessTokenExpiresAt, s.refreshTokenEncrypted, s.expiresAt],
      );
    },
    async find(cookieHash) {
      const r = await pool.query<Who>(
        `update session set last_seen_at = now()
         where cookie_hash = $1 and expires_at > now() and last_seen_at > now() - make_interval(secs => $2)
         returning issuer, subject`,
        [cookieHash, SESSION_IDLE_SECONDS],
      );
      return r.rows[0] ?? null;
    },
    async remove(cookieHash) {
      await pool.query("delete from session where cookie_hash = $1", [cookieHash]);
    },
  };
}
