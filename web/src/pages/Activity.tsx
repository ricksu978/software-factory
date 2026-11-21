// Activity in the SPA (redesign step 8b): the factory's 100 newest events, newest first, with the time in UTC whatever
// the viewer's zone, as today's Activity in src/http/views.ts shows them.
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ActivityProps } from "../api.ts";
import { moveLine } from "../lines.ts";
import { Empty, IssueRef, Time } from "./parts.tsx";

export function Activity({ data }: ActivityProps) {
  return (
    <div>
      <h1 className="mb-3 text-2xl font-semibold">Activity</h1>
      <p className="text-muted-foreground">The 100 newest events, newest first.</p>
      {data.events.length ? (
        <Table>
          <TableHeader>
            <TableRow>{["Time (UTC)", "Item", "Title", "Kind", "Move"].map((h) => <TableHead key={h} scope="col">{h}</TableHead>)}</TableRow>
          </TableHeader>
          <TableBody>
            {data.events.map((e, i) => (
              <TableRow key={i}>
                <TableCell><Time at={e.at} zone="UTC" /></TableCell>
                <TableCell><IssueRef external_id={e.external_id} repo={e.repo} /></TableCell>
                <TableCell>{e.title ?? ""}</TableCell>
                <TableCell>{e.kind}</TableCell>
                <TableCell className="whitespace-normal">{moveLine(e)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : <Empty>No event yet.</Empty>}
    </div>
  );
}
