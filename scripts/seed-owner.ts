// Adds the factory's first owner (plan Task 15). It runs only through `migrate-cli.ts seed-owner`, which in Azure is
// the migrate job, the one identity the database's firewall admits. The words carry no leading dashes, because az
// would read a dash-prefixed word after --args as its own option.
import type pg from "pg";

const PROVIDERS = ["google", "microsoft", "dev"];
const WORDS = ["provider", "issuer", "subject", "email", "github-login"];

/** An issuer is an http or https URL, such as a Keycloak realm (redesign §08, step 5). */
function isIssuerUrl(issuer: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(issuer).protocol);
  } catch {
    return false;
  }
}

/**
 * Inserts or promotes one owner from `provider=<p> | issuer=<url>`, then `subject=<id> [email=<e>]
 * [github-login=<login>] [product-owner]`. An owner is known by a provider or by an issuer, never both.
 */
export async function seedOwner(pool: pg.Pool, words: string[]): Promise<void> {
  const v: Record<string, string> = {};
  let productOwner = false;
  for (const w of words) {
    const [key, ...rest] = w.split("=");
    if (w === "product-owner") productOwner = true;
    else if (rest.length && WORDS.includes(key)) v[key] = rest.join("=");
    else throw new Error(`seed-owner doesn't know the word ${w}`);
  }
  const byIssuer = v.issuer !== undefined;
  if (byIssuer && v.provider !== undefined) throw new Error("seed-owner takes provider= or issuer=, not both");
  if (byIssuer && !isIssuerUrl(v.issuer)) throw new Error(`seed-owner's issuer= must be a URL, such as https://id.example.com/realms/factory`);
  if (!byIssuer && !PROVIDERS.includes(v.provider)) {
    throw new Error(`seed-owner needs provider=${PROVIDERS.join("|")} or issuer=<the sign-in issuer URL>`);
  }
  if (!v.subject) throw new Error("seed-owner needs subject=<the sign-in subject id>");
  const key = byIssuer ? "issuer" : "provider";
  await pool.query(
    `insert into "user" (${key}, subject, email, github_login, role, product_owner) values ($1, $2, $3, $4, 'owner', $5)
     on conflict (${key}, subject) do update set email = coalesce(excluded.email, "user".email),
       github_login = coalesce(excluded.github_login, "user".github_login), role = 'owner',
       product_owner = "user".product_owner or excluded.product_owner`,
    [byIssuer ? v.issuer : v.provider, v.subject, v.email ?? null, v["github-login"] ?? null, productOwner],
  );
}
