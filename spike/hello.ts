// Throwaway control plane for the platform probes (plan Task 2, reused by Task 19). Task 15 replaces it with src/main.ts.
import { BlobSASPermissions, BlobServiceClient } from "@azure/storage-blob";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import pg from "pg";

const local = process.env.FACTORY_ENV === "local";

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function signatureOk(body: Buffer, header: string | undefined): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret || !header?.startsWith("sha256=")) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

// A write-only SAS for a new blob, with its host swapped so a cell container can reach Azurite. The signature covers the path, not the host.
async function sasUrl(): Promise<string> {
  const service = BlobServiceClient.fromConnectionString(process.env.FACTORY_BLOB ?? "");
  const container = service.getContainerClient("probe");
  await container.createIfNotExists();
  const url = new URL(await container.getBlockBlobClient(randomUUID()).generateSasUrl({
    permissions: BlobSASPermissions.parse("cw"),
    expiresOn: new Date(Date.now() + 15 * 60_000),
  }));
  url.hostname = process.env.CELL_BLOB_HOST ?? url.hostname;
  return url.toString();
}

async function runCount(): Promise<number> {
  const client = new pg.Client({ connectionString: process.env.FACTORY_DB_URI });
  await client.connect();
  try {
    const { rows } = await client.query<{ count: string }>("select count(*) from probe_runs");
    return Number(rows[0].count);
  } finally {
    await client.end();
  }
}

createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "GET" && path === "/") {
      return json(res, 200, Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith("x-ms-client-principal"))));
    }
    if (req.method === "POST" && path === "/webhooks/github") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const ok = signatureOk(Buffer.concat(chunks), req.headers["x-hub-signature-256"] as string | undefined);
      return res.writeHead(ok ? 204 : 401).end();
    }
    if (req.method === "POST" && path === "/internal/cells/ping") return res.writeHead(204).end();
    if (local && req.method === "GET" && path === "/probe/sas") return json(res, 200, { url: await sasUrl() });
    if (local && req.method === "GET" && path === "/probe/env") return json(res, 200, Object.keys(process.env).sort());
    if (local && req.method === "GET" && path === "/probe/runs") return json(res, 200, { count: await runCount() });
    res.writeHead(404).end();
  } catch (e) {
    json(res, 500, { error: String(e) });
  }
}).listen(Number(process.env.PORT ?? 7400));
