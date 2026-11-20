// `npm run bdd:repeat -- --times <n> --name "<scenario name>"` runs one scenario n times back to back (PBI 376).
// It exits 0 only when every run passes, and names each run that failed. The work is in src/bdd/repeat.ts.
import { join } from "node:path";
import { main } from "../src/bdd/repeat.ts";

process.exitCode = await main(process.argv.slice(2), join(import.meta.dirname, ".."), process.env);
