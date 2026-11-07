// Adds the factory's first owner (plan Task 15). It runs only through `migrate-cli.ts seed-owner`, which in Azure is
// the migrate job, the one identity the database's firewall admits. The words carry no leading dashes, because az
// would read a dash-prefixed word after --args as its own option.
import type pg from "pg";

const PROVIDERS = ["google", "microsoft", "dev"];

/** Inserts or promotes one owner from `provider=<p> subject=<id> [email=<e>] [github-login=<login>] [product-owner]`. */
export async function seedOwner(pool: pg.Pool, words: string[]): Promise<void> {
  const v: Record<string, string> = {};
  let productOwner = false;
  for (const w of words) {
    const [key, ...rest] = w.split("=");
    if (w === "product-owner") productOwner = true;
    else if (rest.length && ["provider", "subject", "email", "github-login"].includes(key)) v[key] = rest.join("=");
    else throw new Error(`seed-owner doesn't know the word ${w}`);
  }
  if (!PROVIDERS.includes(v.provider)) throw new Error(`seed-owner needs provider=${PROVIDERS.join("|")}`);
  if (!v.subject) throw new Error("seed-owner needs subject=<the sign-in subject id>");
  await pool.query(
    `insert into "user" (provider, subject, email, github_login, role, product_owner) values ($1, $2, $3, $4, 'owner', $5)
     on conflict (provider, subject) do update set email = coalesce(excluded.email, "user".email),
       github_login = coalesce(excluded.github_login, "user".github_login), role = 'owner',
       product_owner = "user".product_owner or excluded.product_owner`,
    [v.provider, v.subject, v.email ?? null, v["github-login"] ?? null, productOwner],
  );
}
