// Run detail in the SPA (redesign step 8b): the item, where it stands and what its run is pinned to, its stages, time,
// policies, readiness checks and scenario verdicts, the Sign off and Answer forms, and an operator's Controls, as
// today's Run detail in src/http/views.ts shows them.
import { useEffect, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatDuration } from "../../../src/core/durations.ts";
import { timeSpent, tokens } from "../../../src/http/format.ts";
import { withEffort } from "../../../src/store/effort.ts";
import { FEATURE_CHANGE_ANCHOR, lineDiff } from "../../../src/core/feature-change.ts";
import type { CiFailure, ItemData, ItemDurations, ReadinessCheck, RunDetailProps, Stage } from "../api.ts";
import { buttonsFor } from "../forms.ts";
import { claimLines, recheckLine } from "../lines.ts";
import { CheckLink } from "./Floor.tsx";
import { A, Banner, CostCell, Empty, H2, IssueRef, Message, onSubmitWith, PrLink, SplitInto, Time, WaitsOnOwner } from "./parts.tsx";

export { submitAnswer, submitItemControls, submitSignOff } from "../forms.ts";

function Head({ columns }: { columns: string[] }) {
  return (
    <TableHeader>
      <TableRow>{columns.map((h) => <TableHead key={h} scope="col">{h}</TableHead>)}</TableRow>
    </TableHeader>
  );
}

/** A Tokens cell, with the exact figures in its title so hovering shows them in full. */
function TokensCell({ tokensIn, tokensOut }: { tokensIn: number | null; tokensOut: number | null }) {
  return <TableCell title={`${tokensIn ?? 0} in, ${tokensOut ?? 0} out`}>{tokens(tokensIn ?? 0)} in, {tokens(tokensOut ?? 0)} out</TableCell>;
}

/** Run detail's line for an item fixing CI (PBI 292): the commit and each failed check, with its address and failing tests. */
function FixingCi({ f }: { f: CiFailure }) {
  return (
    <Banner>
      <p>Fixing CI: Green is fixing the CI failure on commit <code>{f.sha.slice(0, 7)}</code>. The checks that failed:</p>
      {f.checks.length ? (
        <ul className="ml-6 list-disc">
          {f.checks.map((c, i) => (
            <li key={i}>
              <CheckLink c={c} />{c.url ? ` ${c.url}` : ""}
              {c.failingTests.length
                ? <ul className="ml-6 list-disc">{c.failingTests.map((t) => <li key={t}>{t}</li>)}</ul>
                : <> <span className="text-muted-foreground">named no failing test</span></>}
            </li>
          ))}
        </ul>
      ) : <p className="text-muted-foreground">CI named no failed check the factory could read.</p>}
    </Banner>
  );
}

/** A readiness check's Verdict (PBI 348): what its judge call decided, each failed line and flag, or why it has none. */
function Verdict({ c }: { c: ReadinessCheck }) {
  if (c.kind === "split") return null;
  const v = c.verdict;
  const said = !v ? "No verdict was recorded"
    : v.outcome === "passed" ? "Passed"
    : v.outcome === "unreadable" ? "No verdict: the judge's output was unreadable"
    : v.outcome === "error" ? "The call failed with no verdict"
    : "Failed";
  const lines = v?.outcome === "failed" ? [...v.lines.map((l) => `${l.criterion}: ${l.reason}`), ...v.flags.map((f) => `Flag: ${f}`)] : [];
  return (
    <>
      {c.child === undefined ? said : `On the proposed child “${c.child}”: ${said}`}
      {lines.length > 0 && <ul className="ml-6 list-disc">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
    </>
  );
}

/** A dl's term and its value. */
function Term({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <dt className="font-medium">{name}</dt>
      <dd className="mb-1 ml-4">{children}</dd>
    </>
  );
}

/** Run detail's Time section (PBI 187): the total, the time Queued, each wait on a person, and each stage's time. */
function TimeSection({ t }: { t: ItemDurations }) {
  const ms = (n: number | null) => (n === null ? "not known yet" : formatDuration(n));
  const w = t.waiting;
  return (
    <>
      <H2>Time</H2>
      <dl><Term name="Total">{ms(t.totalMs)}</Term><Term name="Queued">{ms(t.queuedMs)}</Term></dl>
      <h3 className="mt-3 font-semibold">Waiting on a person</h3>
      <dl>
        <Term name="Sign-off">{ms(w.signOffMs)}</Term><Term name="Needs input">{ms(w.needsInputMs)}</Term>
        <Term name="In review">{ms(w.inReviewMs)}</Term><Term name="Waiting on a person">{ms(w.totalMs)}</Term>
      </dl>
      <h3 className="mt-3 font-semibold">Time in each stage</h3>
      {t.stages.length ? (
        <Table>
          <Head columns={["Stage", "Time", "Attempts"]} />
          <TableBody>
            {t.stages.map((s) => (
              <TableRow key={s.stageId}><TableCell>{s.stageId}</TableCell><TableCell>{formatDuration(s.ms)}</TableCell><TableCell>{s.attempts}</TableCell></TableRow>
            ))}
          </TableBody>
        </Table>
      ) : <Empty>No stage has run yet.</Empty>}
    </>
  );
}

/**
 * PBI 366: the feature change request the item waits on, each file under its path with the stage's reason and its
 * change from the lock commit, each line taken out and put in marked by its side, as the dashboard's item page draws it.
 */
function FeatureChange({ files }: { files: NonNullable<ItemData["featureChange"]> }) {
  return (
    <>
      <H2 id={FEATURE_CHANGE_ANCHOR}>Feature change request</H2>
      <p>A stage after sign-off asks to change {files.length === 1 ? "this locked feature file" : "these locked feature files"}. The branch keeps {files.length === 1 ? "it" : "them"} as at the lock commit, and the item waits on the Product Owner.</p>
      {files.map((f) => (
        <div key={f.path}>
          <h3 className="mt-3 font-mono text-sm font-semibold">{f.path}</h3>
          <p data-reason>{f.reason}</p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{lineDiff(f.before, f.after).map((l, i) => <span key={i}>{i > 0 && "\n"}{l === null ? "…" : l.side === "before" ? <del data-side="before">{l.text}</del> : l.side === "after" ? <ins data-side="after">{l.text}</ins> : <span data-side="same">{l.text}</span>}</span>)}</pre>
        </div>
      ))}
    </>
  );
}

/** Feature files, each under its path with its text as written. */
function Files({ files }: { files: { path: string; text: string }[] }) {
  return files.map((f) => (
    <div key={f.path}>
      <h3 className="mt-3 font-mono text-sm font-semibold">{f.path}</h3>
      <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{f.text}</pre>
    </div>
  ));
}

/** The Stages table: each attempt, how long it took, what it used and cost, its transcript and its notes. */
function Stages({ d, zone, now }: { d: ItemData; zone: string; now: Date }) {
  const at = (s: Stage) => (s.started_at ? Date.parse(s.started_at) : NaN);
  // An attempt with no end is running only while the item is In progress on an open run, and only if it's the run's
  // newest attempt, so a row a dead cell left open never counts against now (PBI 209, PBI 239).
  const newest = d.stages.reduce<Stage | null>((a, s) => (s.started_at && (!a?.started_at || at(s) >= at(a)) ? s : a), null);
  const live = (s: Stage) => d.item.state === "InProgress" && d.run?.open === true && s === newest;
  const took = (s: Stage) => !s.started_at ? ""
    : s.ended_at ? timeSpent(new Date(s.started_at), new Date(s.ended_at))
    : live(s) ? `${timeSpent(new Date(s.started_at), now)} so far` : "didn't finish";
  const status = (s: Stage) => (s.status !== "started" || s.ended_at ? s.status : live(s) ? "running" : "stopped");
  const notes = (s: Stage) => [
    ...(s.message ? [s.message] : []),
    ...(s.restates ?? []).map((x) => `Needed a second ask of the PR reviewer in round ${x.round}: ${x.reason}`),
  ];
  if (!d.stages.length) return <Empty>No stage has run yet.</Empty>;
  return (
    <Table>
      <Head columns={["Stage", "Attempt", "Status", "Model", "Started", "Time spent", "Tokens", "Cost", "Transcript", "Notes"]} />
      <TableBody>
        {d.stages.map((s, i) => (
          <TableRow key={i}>
            <TableCell>{s.stage_id}</TableCell>
            <TableCell>{s.attempt}</TableCell>
            <TableCell>{status(s)}</TableCell>
            <TableCell>{s.model ? withEffort(s.model, s.effort) : "model not recorded"}</TableCell>
            <TableCell>{s.started_at ? <Time at={s.started_at} zone={zone} /> : ""}</TableCell>
            <TableCell>{took(s)}</TableCell>
            <TokensCell tokensIn={s.tokens_in} tokensOut={s.tokens_out} />
            <CostCell usd={s.cost_usd} />
            <TableCell>{!s.transcript_ref ? "" : d.linkBlobs ? <A href={`/bff/v1/blobs/${s.transcript_ref}`}>transcript</A> : s.transcript_ref}</TableCell>
            <TableCell className="whitespace-normal">{notes(s).map((n, j) => <span key={j}>{j > 0 && <br />}{n}</span>)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function RunDetail({ data: d, zone, now, message, onSubmit }: RunDetailProps) {
  const r = d.run;
  const c = d.controls;
  const q = d.question;
  const hasRequest = Boolean(d.featureChange?.length);
  // PBI 366: the browser jumps to the address's anchor on load, before the read draws the Feature change request
  // section, so once it is drawn this scrolls to it when the address names it, as Floor's link does.
  useEffect(() => {
    if (!hasRequest || window.location.hash !== `#${FEATURE_CHANGE_ANCHOR}`) return;
    document.getElementById(FEATURE_CHANGE_ANCHOR)?.scrollIntoView();
  }, [hasRequest]);
  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold"><IssueRef external_id={d.item.external_id} repo={d.item.repo} /> {d.item.title}</h1>
      <Message text={message} />
      <p>{d.item.state}{r?.open && <PrLink r={{ ...r, state: d.item.state }} />}{r?.next_stage ? `, resumes at ${r.next_stage}` : ""}{d.item.state === "FeatureChangeRequest" && d.featureChange?.length ? <>.<WaitsOnOwner path="" /></> : null}</p>
      {d.featureChange?.length ? <FeatureChange files={d.featureChange} /> : null}
      {d.recheck && <p>{recheckLine(d.recheck.last, zone, true)}</p>}
      {d.splitInto?.length ? <><H2>Split into</H2><SplitInto children={d.splitInto} /></> : null}
      {d.claim && <p>{claimLines(d.claim)}</p>}
      {d.startNow && <p>Marked Start now: {d.startNow.reason}{d.startNow.by ? `, by ${d.startNow.by}` : ""}. The next free slot claims it first once it's Queued, not held and not blocked.</p>}
      {d.moveEnded && (
        <p>
          {d.moveEnded.control} ended by a change to the board's order, at <Time at={d.moveEnded.at} zone={zone} />: the board now puts the item and the item it passed the other way round from when it was moved, so it follows the board again.
        </p>
      )}
      {d.fixingCi && <FixingCi f={d.fixingCi} />}
      <dl className="mt-3">
        <Term name="SOP version">{r?.sop_version ?? "not pinned yet"}</Term>
        <Term name="Config">{r?.config_sha ?? "not pinned yet"}</Term>
        <Term name="Scenarios locked at">{r?.features_lock_sha ?? "not signed off"}</Term>
        <Term name="Shadow risk tier">
          {r?.risk_tier ?? "not classified"}
          {r?.tier_reasons?.length ? <ul className="ml-6 list-disc">{r.tier_reasons.map((t) => <li key={t}>{t}</li>)}</ul> : null}
        </Term>
      </dl>
      {d.scope && <><H2>Scope</H2><pre className="whitespace-pre-wrap font-sans">{d.scope}</pre></>}
      {d.criteria && (
        <>
          <H2>Criteria and their scenarios</H2>
          <ol className="ml-6 list-decimal">
            {d.criteria.map((k, i) => (
              <li key={i}>
                {k.criterion}
                {k.scenarios.length
                  ? <ul className="ml-6 list-disc">{k.scenarios.map((s, j) => <li key={j}>{s.name}{s.regression && <> <strong>expected to pass at Red</strong></>}</li>)}</ul>
                  : <> <strong>no scenario</strong></>}
              </li>
            ))}
          </ol>
        </>
      )}
      {d.pending.length > 0 && <><H2>Scenarios up for sign-off</H2><Files files={d.pending} /></>}
      {/* The owner approves only scenarios they can read here. Until the cell API stores the files at the scenarios sha,
          the SPA may have none to show, so it sends the owner to today's dashboard to sign off instead. */}
      {q?.kind === "sign_off" && d.pending.length === 0 && (
        <>
          <H2>Sign off</H2>
          <p>The scenarios up for sign-off can't be shown here yet, so this page doesn't take the decision. Open the item's Run detail on today's dashboard, which shows the scope, the criteria and the scenarios, and sign off there.</p>
        </>
      )}
      {q?.kind === "sign_off" && d.pending.length > 0 && (
        <>
          <H2>Sign off</H2>
          <form aria-label="Sign off" className="max-w-xl space-y-2" onSubmit={onSubmitWith("note", onSubmit && ((b, v) => onSubmit("Sign off", b, v)))}>
            <label htmlFor="signoff-note" className="block text-sm font-medium">Note for the factory</label>
            <Textarea id="signoff-note" name="note" />
            <p className="flex gap-2"><Button type="submit">Approve the scenarios</Button><Button type="submit" variant="outline">Ask for changes</Button></p>
          </form>
        </>
      )}
      {q?.kind === "needs_input" && (
        <>
          <H2>Answer</H2>
          <p className="whitespace-pre-wrap">{q.body}</p>
          <form aria-label="Answer" className="max-w-xl space-y-2" onSubmit={onSubmitWith("answer", onSubmit && ((b, v) => onSubmit("Answer", b, v)))}>
            <label htmlFor="answer" className="block text-sm font-medium">Your answer</label>
            <Textarea id="answer" name="answer" required />
            <p><Button type="submit">Send the answer</Button></p>
          </form>
        </>
      )}
      {c && (
        <>
          <H2>Controls</H2>
          <form aria-label="Controls" className="max-w-xl space-y-2" onSubmit={onSubmitWith("reason", onSubmit && ((b, v) => onSubmit("Controls", b, v)))}>
            <label htmlFor="item-reason" className="block text-sm font-medium">Reason</label>
            <Input id="item-reason" name="reason" required />
            <p className="flex flex-wrap gap-2">{buttonsFor(c).map((b) => <Button key={b} type="submit" variant="outline">{b}</Button>)}</p>
          </form>
        </>
      )}
      {d.verdicts.length > 0 && (
        <>
          <H2>Scenarios at red and green</H2>
          <Table>
            <Head columns={["Scenario", "Red", "Green"]} />
            <TableBody>
              {d.verdicts.map((v, i) => <TableRow key={i}><TableCell>{v.name}</TableCell><TableCell>{v.red}</TableCell><TableCell>{v.green}</TableCell></TableRow>)}
            </TableBody>
          </Table>
        </>
      )}
      {d.durations && <TimeSection t={d.durations} />}
      <H2>Policy results</H2>
      {d.policies.length ? (
        <Table>
          <Head columns={["File", "Criterion", "Result", "Reason"]} />
          <TableBody>
            {d.policies.map((p, i) => (
              <TableRow key={i}>
                <TableCell>{p.file}.md <span className="text-muted-foreground">{p.source}</span></TableCell>
                <TableCell>{p.criterion}</TableCell><TableCell>{p.status}</TableCell><TableCell className="whitespace-normal">{p.reason ?? ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : <Empty>No policy results yet.</Empty>}
      <H2>Stages</H2>
      <p className="text-muted-foreground">Times show in {zone}.</p>
      <Stages d={d} zone={zone} now={now} />
      <H2>Readiness checks</H2>
      {d.readiness.length ? (
        <Table>
          <Head columns={["Ran", "Call", "Model", "Tokens", "Cost", "Verdict"]} />
          <TableBody>
            {d.readiness.map((k, i) => (
              <TableRow key={i}>
                <TableCell><Time at={k.ranAt} zone={zone} /></TableCell>
                <TableCell>{k.kind === "split" ? "Split proposal" : "Judge"}</TableCell>
                <TableCell>{withEffort(k.model, k.effort)}</TableCell>
                <TokensCell tokensIn={k.tokensIn} tokensOut={k.tokensOut} />
                <CostCell usd={k.costUsd} />
                <TableCell className="whitespace-normal"><Verdict c={k} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : <Empty>No readiness check has run yet.</Empty>}
      {d.features.length > 0 && <><H2>Signed-off scenarios</H2><Files files={d.features} /></>}
    </div>
  );
}
