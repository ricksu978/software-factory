// `npm run bdd` runs the BDD suite in BDD_WORKERS parallel workers (PBI 390). The work is in src/bdd/run.ts.
import { main } from "../src/bdd/run.ts";

process.exitCode = await main(process.argv.slice(2), process.cwd(), process.env);
