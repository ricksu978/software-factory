// `npm run build`: type-checks the SPA in web/ and builds it with Vite into web/dist, where the BFF serves it from
// (redesign step 8a, src/bff/spa.ts). A type error fails the build before Vite runs, and tsc's output names the file.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { build } from "vite";

const repo = join(import.meta.dirname, "..");
const web = join(repo, "web");

const tsc = spawnSync(process.execPath, [join(repo, "node_modules", "typescript", "bin", "tsc"), "-p", join(web, "tsconfig.json")], {
  cwd: repo,
  stdio: "inherit",
});
if (tsc.status !== 0) {
  console.error("npm run build: the SPA has type errors, so it wasn't built");
  process.exit(tsc.status || 1);
}

await build({ configFile: join(web, "vite.config.ts"), logLevel: "warn" });
console.log(`npm run build: the SPA is built in ${join("web", "dist")}`);
