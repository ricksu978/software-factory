// Floor in the SPA (redesign step 8b): what waits on a person, what's next, the final-stage, not-ready, blocked, split
// and failed items, what's in flight, the factory's banners, and an operator's Controls, as today's Floor in
// src/http/views.ts shows them. Since step 8c (PBI 280) it also shows when the worker last ticked, with the count of
// outbox rows set aside beside it, and a "Scheduler not ticking" banner once that heartbeat is more than a minute old.
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { CiFailure, FloorData, FloorProps, MainBreak } from "../api.ts";
import { FLOOR_KINDS } from "../forms.ts";
import { PATHS } from "../routes.ts";
import { age, blockedReason, drainLine, heartbeatLine, mainRedLead, recheckLine, restartLine, schedulerBanner } from "../lines.ts";
import { A, Banner, CostCell, Empty, H2, IssueRef, ItemName, Message, onSubmitWith, PrLink, SplitInto, Standing } from "./parts.tsx";

export { submitFloorControls } from "../forms.ts";

const FACTORY_STATE: Record<string, string> = { pause: "Paused", kill: "Killed" };
const short = (sha: string) => sha.slice(0, 7);

/** A list of rows, or the note that says the list is empty. */
function List({ rows, empty }: { rows: ReactNode[]; empty: string }) {
  return rows.length ? <ol className="ml-6 list-decimal space-y-1">{rows}</ol> : <Empty>{empty}</Empty>;
}

/** A failed check's name, linked to its run when its address is https, so a link a cell sent can't run script. */
export function CheckLink({ c }: { c: CiFailure["checks"][number] }) {
  return /^https:\/\//.test(c.url) ? <A href={c.url}>{c.name}</A> : <>{c.name}</>;
}

/** The Stage cell for an item fixing CI (PBI 292): the checks that failed and the commit, in place of "green". */
function FixingCiStage({ f }: { f: CiFailure }) {
  return (
    <>
      fixing CI{" "}
      <span className="text-muted-foreground">
        {f.checks.length ? f.checks.map((c, i) => <span key={i}>{i > 0 && ", "}<CheckLink c={c} /></span>) : "no check the factory could read"} failed on <code>{short(f.sha)}</code>
      </span>
    </>
  );
}

/** One break on main (PBI 255): the commit, the PR and item it came from, and what became of its bug item. */
function MainBreakLine({ r }: { r: MainBreak }) {
  if (r.charged === null) {
    return <li><code>{r.branch}</code> was already red at commit <code>{short(r.sha)}</code>, which the factory didn't merge, so it filed no bug item. Someone needs to fix <code>{r.branch}</code>.</li>;
  }
  const from = r.pr_number !== null ? <>PR #{r.pr_number} for item <IssueRef external_id={r.charged} repo={r.repo} /></> : <>item <IssueRef external_id={r.charged} repo={r.repo} /></>;
  const bug = r.bug_external_id === null
    ? <>The factory is filing its bug item.</>
    : (
      <>
        Its bug item {r.bug_id && r.bug_title ? <ItemName r={{ id: r.bug_id, title: r.bug_title, external_id: r.bug_external_id, repo: r.repo }} /> : <IssueRef external_id={r.bug_external_id} repo={r.repo} />}{" "}
        {r.bug_state === "Failed" ? `failed to make ${r.branch} pass, so ${r.branch} stays red until it's re-queued or someone fixes it` : "is claimed first"}.
      </>
    );
  return <li>Commit <code>{short(r.sha)}</code> broke <code>{r.branch}</code>, the merge of {from}. {bug}</li>;
}

/** The factory's state and what needs attention, each as a banner, as today's Floor shows them. */
function Banners({ f, now }: { f: FloorData; now: Date }) {
  const stale = schedulerBanner(f.workerHeartbeat, now);
  return (
    <>
      {stale && <Banner>{stale}</Banner>}
      {f.mainBreaks.length > 0 && (
        <Banner>
          <p>{mainRedLead(f.mainBreaks)}</p>
          <ul className="ml-6 list-disc">{f.mainBreaks.map((r, i) => <MainBreakLine key={i} r={r} />)}</ul>
        </Banner>
      )}
      {f.factory.map((o, i) => o.kind === "drain"
        ? <Banner key={i}>{drainLine(o.reason, f.running)}</Banner>
        : FACTORY_STATE[o.kind] ? <Banner key={i}>{FACTORY_STATE[o.kind]}: {o.reason}</Banner> : null)}
      {f.restart && <Banner>{restartLine(f.restart)}</Banner>}
      {f.cellImage && (
        <p className="text-muted-foreground">
          The cell image was built from commit {f.cellImage.built ? <code>{short(f.cellImage.built)}</code> : "not known: it carries no commit label, as an image built from a checkout with uncommitted edits doesn't"}.
        </p>
      )}
      {f.cellImage?.restart && (
        <Banner>
          A restart is needed to pick up main's commit <code>{short(f.cellImage.restart)}</code>. It changes code the control plane or the worker runs, so the cell image isn't rebuilt until the factory restarts.
        </Banner>
      )}
      {f.baseFails.length > 0 && (
        <Banner>
          <p>The base fails in cells. These items wait on it, since their Definition of Done or their CI fails the same tests on the base commit. Fix the base, then answer each item's question.</p>
          <ul className="ml-6 list-disc">
            {f.baseFails.map((r) => (
              <li key={r.id}>
                <ItemName r={r} /> <span className="text-muted-foreground">at base commit {short(r.sha)}</span>
                <ul className="ml-6 list-disc">{r.tests.map((t) => <li key={t}>{t}</li>)}</ul>
              </li>
            ))}
          </ul>
        </Banner>
      )}
      {f.claudeToken?.banner && <Banner>{f.claudeToken.banner}</Banner>}
    </>
  );
}

/** The worker's heartbeat and, beside it, the outbox rows the worker set aside after their tenth failed attempt. */
function WorkerLine({ f, now }: { f: FloorData; now: Date }) {
  if (f.workerHeartbeat === undefined && f.outboxSetAside === undefined) return null;
  return (
    <p className="text-muted-foreground">
      {f.workerHeartbeat !== undefined && <span>{heartbeatLine(f.workerHeartbeat, now)}</span>}{" "}
      {f.outboxSetAside !== undefined && <span>Outbox rows set aside: {f.outboxSetAside}</span>}
    </p>
  );
}

export function Floor({ data: f, now, zone, message, onSubmit, onReasonField, controlsKey }: FloorProps) {
  const st = (id: string) => <Standing k={f.keys[id]} />;
  return (
    <div>
      <h1 className="mb-3 text-2xl font-semibold">Floor</h1>
      <Message text={message} />
      <Banners f={f} now={now} />
      <WorkerLine f={f} now={now} />
      <p>
        {f.waitingCount} of {f.capacity} waiting. <A href={PATHS.activity}>Activity</A> <A href={PATHS.phase0}>Phase 0 report</A>
      </p>
      <H2>Waiting on you</H2>
      <List empty="Nothing waits on you." rows={f.waiting.map((w) => (
        <li key={w.id}><ItemName r={w} /><PrLink r={w} /> <span className="text-muted-foreground">{w.state}, waiting {age(w.since, now)}</span>{st(w.id)}</li>
      ))} />
      <H2>Next up</H2>
      <List empty="Nothing is ready to start." rows={f.next.map((n) => <li key={n.id}><ItemName r={n} />{st(n.id)}</li>)} />
      <H2>Final stage</H2>
      <List empty="No item is in the review loop, and none is depended on by one that is." rows={f.finalStage.map((n) => (
        <li key={n.id}><ItemName r={n} /> <span className="text-muted-foreground">{n.state}</span>{st(n.id)}</li>
      ))} />
      <H2>Not ready</H2>
      <List empty="Every item that entered is ready." rows={f.notReady.map((n) => (
        <li key={n.id}><ItemName r={n} />{st(n.id)}<ul className="ml-6 list-disc">{n.failed.map((l, i) => <li key={i}>{l}</li>)}</ul></li>
      ))} />
      <H2>Blocked</H2>
      <List empty="No ready item waits on another." rows={f.blocked.map((b) => (
        <li key={b.id}><ItemName r={b} /> <span className="text-muted-foreground">{blockedReason(b.blocked_by)}</span>{st(b.id)}</li>
      ))} />
      <H2>Split</H2>
      <List empty="No item is split into children that are still open." rows={f.split.map((p) => (
        <li key={p.id}><ItemName r={p} /> <span className="text-muted-foreground">Split into</span><SplitInto children={p.children} /></li>
      ))} />
      <H2>Failed on main</H2>
      <List empty="No item failed its Definition of Done on main." rows={f.failed.map((n) => (
        <li key={n.id}><ItemName r={n} /> <span className="text-muted-foreground">{recheckLine(n.rechecked, zone, false)}</span></li>
      ))} />
      <H2>In flight</H2>
      {f.active.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              {["Item", "State", "Stage", "In stage", "Cost", "Last agent message"].map((h) => <TableHead key={h} scope="col">{h}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {f.active.map((a) => (
              <TableRow key={a.id}>
                <TableCell>
                  <ItemName r={a} /><PrLink r={a} />
                  {a.badges.map((b) => <span key={b}> <Badge variant="secondary">{b}</Badge></span>)}
                  {st(a.id)}
                </TableCell>
                <TableCell>{a.state}</TableCell>
                <TableCell>{a.ci_failure ? <FixingCiStage f={a.ci_failure} /> : a.stage ?? ""}</TableCell>
                <TableCell>{age(a.since, now)}</TableCell>
                <CostCell usd={a.cost} />
                <TableCell className="text-muted-foreground whitespace-normal">{a.message ?? ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : <Empty>No item is in flight.</Empty>}
      {f.canOperate && (
        <>
          <H2>Controls</H2>
          <form key={controlsKey} aria-label="Controls" className="max-w-xl space-y-2" onSubmit={onSubmitWith("reason", onSubmit && ((b, v) => onSubmit("Controls", b, v)))}>
            <label htmlFor="floor-reason" className="block text-sm font-medium">Reason</label>
            <Input
              id="floor-reason" name="reason" required
              onFocus={(e) => onReasonField?.({ value: e.currentTarget.value, focused: true })}
              onChange={(e) => onReasonField?.({ value: e.currentTarget.value, focused: true })}
              onBlur={(e) => onReasonField?.({ value: e.currentTarget.value, focused: false })}
            />
            <p className="flex flex-wrap gap-2">
              {Object.keys(FLOOR_KINDS).map((b) => <Button key={b} type="submit" variant={b === "Kill switch" ? "destructive" : "outline"}>{b}</Button>)}
            </p>
          </form>
        </>
      )}
    </div>
  );
}
