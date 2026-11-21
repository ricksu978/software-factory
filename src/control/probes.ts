// PBI 2's platform probes, for the local platform only: a cell's ping, an upload URL, the names of the service's
// environment variables and migrate's run count. The cell API serves them (redesign step 4b), since they test what a
// cell can reach, and today's control plane keeps them for PBI 6's scenarios until the cut-over.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { json, type Handler } from "../http/server.ts";

/** The probes as one handler. Any other request falls through to the next handler. */
export function platformProbes(d: { pool: pg.Pool; uploadUrl: (path: string) => Promise<string> }): Handler {
  return async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "POST" && path === "/internal/cells/ping") json(res, 204);
    else if (req.method === "GET" && path === "/probe/sas") json(res, 200, { url: await d.uploadUrl(`probe/${randomUUID()}`) });
    else if (req.method === "GET" && path === "/probe/env") json(res, 200, Object.keys(process.env).sort());
    else if (req.method === "GET" && path === "/probe/runs") json(res, 200, { count: Number((await d.pool.query("select count(*) from probe_runs")).rows[0].count) });
    else return false;
    return true;
  };
}
