// Dashboard sign-in (plan Task 15). In Azure, Container Apps built-in auth signs people in and adds principal
// headers. Locally nothing sits in front of the app, so each start makes a token and prints a one-time link.
import { randomBytes, timingSafeEqual } from "node:crypto";

export type Provider = "google" | "microsoft" | "dev";
export type Identity = { provider: Provider; subject: string; tenantId: string | null };
export type Role = "viewer" | "operator" | "owner";

export type Auth = {
  /** This start's dev token. Empty in Azure mode. */
  devToken: string;
  identify(path: string, headers: Record<string, string | string[] | undefined>): Identity | null;
  /** The Set-Cookie value for GET /dev-login with `token`, or null when the token is wrong or this isn't local mode. */
  devLoginCookie(token: string): string | null;
};

export const DEV_COOKIE = "factory_dev";
const idps: Record<string, Provider> = { aad: "microsoft", microsoftaccount: "microsoft", google: "google" };

const header = (h: Record<string, string | string[] | undefined>, name: string) => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function cookie(h: Record<string, string | string[] | undefined>, name: string): string | null {
  for (const part of (header(h, "cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/**
 * Sign-in for one start of the control plane. Routes under /webhooks and /internal never get an identity in either
 * mode, so a spoofed principal header there authenticates nothing (Review Focus 4). Local mode never reads
 * principal headers, and Azure mode never reads the dev cookie.
 */
export function createAuth(cfg: { mode: "local" | "azure"; devLogin?: string }): Auth {
  const devToken = cfg.mode === "local" ? randomBytes(32).toString("hex") : "";
  return {
    devToken,
    identify(path, headers) {
      if (path.startsWith("/webhooks") || path.startsWith("/internal")) return null;
      if (cfg.mode === "local") {
        const sent = cookie(headers, DEV_COOKIE);
        return sent && cfg.devLogin && sameSecret(sent, devToken) ? { provider: "dev", subject: cfg.devLogin, tenantId: null } : null;
      }
      const provider = idps[(header(headers, "x-ms-client-principal-idp") ?? "").toLowerCase()];
      const subject = header(headers, "x-ms-client-principal-id");
      return provider && subject ? { provider, subject, tenantId: null } : null;
    },
    devLoginCookie(token) {
      if (cfg.mode !== "local" || !sameSecret(token, devToken)) return null;
      return `${DEV_COOKIE}=${devToken}; HttpOnly; SameSite=Strict; Path=/`;
    },
  };
}

/**
 * The dev identity guard. Returns why the control plane must refuse to start, or null. It refuses a dev login
 * outside local mode, local mode without a dev login, and either one inside an Azure Container App, which always
 * has CONTAINER_APP_NAME set.
 */
export function devIdentityProblem(env: Record<string, string | undefined>): string | null {
  const local = env.FACTORY_ENV === "local";
  const login = (env.FACTORY_DEV_LOGIN ?? "") !== "";
  if (env.CONTAINER_APP_NAME && (local || login)) return "FACTORY_ENV=local or FACTORY_DEV_LOGIN is set inside a Container App";
  if (login && !local) return "FACTORY_DEV_LOGIN is set but FACTORY_ENV isn't local";
  if (local && !login) return "FACTORY_ENV is local but FACTORY_DEV_LOGIN is empty";
  return null;
}

const rank: Record<Role, number> = { viewer: 0, operator: 1, owner: 2 };

/** True when `user` holds `role` or a higher one. */
export function requireRole(user: { role: Role }, role: Role): boolean {
  return rank[user.role] >= rank[role];
}
