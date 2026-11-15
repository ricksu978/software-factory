// The BFF's sessions (redesign step 7a, 2026-11-07 design §04 and §08). The browser holds only the session cookie, a
// random id. The session row in Postgres holds the token's issuer and subject, the access token, and the refresh
// token sealed under the session key (BFF_SESSION_KEY, 32 random bytes in base64).

/** The name of the session cookie the BFF sets after sign-in and clears at /auth/logout. */
export const SESSION_COOKIE = "factory_session";

/** Seals a refresh token under the session key, for session.refresh_token_encrypted. */
export function sealRefreshToken(_key: string, _token: string): string {
  throw new Error("sealRefreshToken is not implemented yet");
}

/** Opens a refresh token sealed by sealRefreshToken under the same session key, and throws under any other key. */
export function openRefreshToken(_key: string, _sealed: string): string {
  throw new Error("openRefreshToken is not implemented yet");
}
