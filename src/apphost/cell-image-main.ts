// The "cell-image" resource's process (PBI 206). aspire-apphost/apphost.mts runs it as a Node app in the repo root,
// and the worker waits for it to exit with 0. It builds factory-cell:local from this checkout, with its
// cell/Dockerfile, and exits 1 when the build fails. The AppHost's start checks have run, and its pull of main has
// finished, before Aspire starts any resource, so it builds the pulled checkout.
import { join } from "node:path";
import { runCellImageResource } from "./cell-image.ts";
import { nodeStartDeps } from "./node-start.ts";

const repo = join(import.meta.dirname, "..", "..");
process.exitCode = await runCellImageResource(nodeStartDeps(repo), (l) => console.log(l), (l) => console.error(l));
