// Who each scenario signed in, where and through what (PBI 283). A step that signs someone in to the dashboard records
// it here with recordSignIn, and a step that then opens a page as them records that with recordOpened. A whole cucumber
// run writes every record of its process to the file PBI283_SIGN_INS names, one JSON line each. PBI 283's steps set it
// for the runs of PBI 19's and PBI 89's scenarios they start, and read it back after.
//
// Each record carries the id of the pickle the scenario ran, so a record can be told apart by the example it came from.
// Nothing is written when PBI283_SIGN_INS is unset, which is every run but the ones PBI 283 starts.
import { Before } from "@cucumber/cucumber";
import { appendFileSync } from "node:fs";

/** Where someone signed in: the test sign-in provider the test started, Keycloak, or the dev sign-in. */
export type SignedInAt = "test-provider" | "keycloak" | "dev-login";

export type SignIn = {
  kind: "sign-in";
  pickleId: string;
  person: string;
  at: SignedInAt;
  /** Keycloak's realm, for a sign-in at Keycloak. */
  realm?: string;
  /** What the browser signed in through: the BFF's /auth/login, or something else, such as a cookie set by hand. */
  through: "bff" | "other";
};

export type Opened = { kind: "opened"; pickleId: string; person: string; page: string };

export type SignInRecord = SignIn | Opened;

export const SIGN_INS_ENV = "PBI283_SIGN_INS";

let pickleId = "";

Before(function ({ pickle }) {
  pickleId = pickle.id;
});

function write(record: SignInRecord): void {
  const file = process.env[SIGN_INS_ENV];
  if (file) appendFileSync(file, `${JSON.stringify(record)}\n`);
}

/** Records that this scenario signed `person` in. */
export function recordSignIn(person: string, at: SignedInAt, through: SignIn["through"], realm?: string): void {
  write({ kind: "sign-in", pickleId, person, at, through, ...(realm ? { realm } : {}) });
}

/** Records that this scenario opened `page`, such as "Floor", as `person`. */
export function recordOpened(person: string, page: string): void {
  write({ kind: "opened", pickleId, person, page });
}
