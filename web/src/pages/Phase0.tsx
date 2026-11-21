// The Phase 0 report in the SPA (redesign step 8b): the merged PRs, their cost and the readiness spend, as today's
// report in src/http/views.ts shows them. Stage spend is the merged runs' stages. Readiness spend is every readiness
// check on every item, so the items the gate turned away count too (PBI 132).
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Phase0Props } from "../api.ts";
import { judgeUsd, summary, usd } from "../lines.ts";
import { A, Empty, ItemName } from "./parts.tsx";

export function Phase0({ data }: Phase0Props) {
  const total = data.runs.reduce((sum, r) => sum + r.cost, 0);
  return (
    <div>
      <h1 className="mb-3 text-2xl font-semibold">Phase 0 report</h1>
      <p>{summary(data.runs.map((r) => r.cost))}</p>
      <dl className="my-3">
        <dt className="font-medium">Stage spend</dt><dd className="mb-1 ml-4">{usd(total)}</dd>
        <dt className="font-medium">Readiness spend</dt><dd className="mb-1 ml-4">{judgeUsd(data.readinessSpend)}</dd>
      </dl>
      {data.runs.length ? (
        <Table>
          <TableHeader>
            <TableRow>{["Item", "PR", "Merged", "Cost", "Shadow tier"].map((h) => <TableHead key={h} scope="col">{h}</TableHead>)}</TableRow>
          </TableHeader>
          <TableBody>
            {data.runs.map((r, i) => (
              <TableRow key={i}>
                <TableCell><ItemName r={{ ...r, id: r.item_id }} /></TableCell>
                <TableCell>{r.pr_url ? <A href={r.pr_url}>{r.pr_url}</A> : ""}</TableCell>
                <TableCell>{r.merged_at ? new Date(r.merged_at).toISOString().slice(0, 10) : ""}</TableCell>
                <TableCell>{usd(r.cost)}</TableCell>
                <TableCell>
                  {r.risk_tier ?? "not classified"}
                  {r.tier_reasons?.length ? <ul className="ml-6 list-disc">{r.tier_reasons.map((t) => <li key={t}>{t}</li>)}</ul> : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : <Empty>No factory PR has merged yet.</Empty>}
    </div>
  );
}
