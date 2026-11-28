// PBI 326: a stage attempt's transcript as a conversation, in the order it happened (web/src/transcript.ts reads it):
// each call's brief, then each assistant turn's thinking, text and tool calls, each call followed by its result, the
// subagent tasks' starts and finishes, and each call's final result. A long text shows its first lines in a <details>
// that opens to the rest, so a large transcript reads as a page of short turns. Everything from the transcript is
// drawn as React text, never as HTML, and no Markdown is turned into links. A running attempt shows what the cell has
// uploaded so far (PBI 209), and the raw JSON Lines file is one click away.
//
// The page's structure, which the feature's steps read: an element with data-entry per step of the conversation
// ("brief", "turn", "subagent-start", "subagent-finish", "result", "unreadable"), and inside a turn an element with
// data-part per part ("thinking", "text", "tool-call", "tool-result"). A tool call names its tool in data-slot="tool-name".
import type { ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cost, tokens } from "../../../src/http/format.ts";
import type { TranscriptProps } from "../api.ts";
import { clip, readConversation, type Entry, type Part, type ToolResult } from "../transcript.ts";
import { A, ItemName } from "./parts.tsx";

/** A text from the transcript: its first lines, and a <details> that opens to the rest when there's more. */
function LongText({ text, className = "" }: { text: string; className?: string }) {
  const c = clip(text);
  const pre = `whitespace-pre-wrap break-words font-mono text-sm ${className}`;
  return (
    <>
      <pre className={pre}>{c.head}</pre>
      {c.rest && (
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">Show the rest: {c.more}</summary>
          <pre className={pre}>{c.rest}</pre>
        </details>
      )}
    </>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</div>;
}

function Card({ entry, children, className = "" }: { entry: Entry["kind"]; children: ReactNode; className?: string }) {
  return <section data-entry={entry} className={`my-3 rounded-md border p-3 ${className}`}>{children}</section>;
}

function Result({ r }: { r: ToolResult }) {
  return (
    <div data-part="tool-result" {...(r.error ? { "data-error": "" } : {})} className={`ml-4 border-l-2 pl-3 ${r.error ? "border-destructive" : ""}`}>
      <Label>{r.error ? "Result: error" : "Result"}</Label>
      <LongText text={r.text} className={r.error ? "text-destructive" : ""} />
    </div>
  );
}

function TurnPart({ p }: { p: Part }) {
  if (p.kind === "thinking") {
    return (
      <div data-part="thinking" className="my-2 italic text-muted-foreground">
        <Label>Thinking</Label>
        {p.text === null ? <p className="text-sm">The model's thinking was withheld: its content is redacted.</p> : <LongText text={p.text} />}
      </div>
    );
  }
  if (p.kind === "text") return <div data-part="text" className="my-2"><LongText text={p.text} /></div>;
  return (
    <>
      <div data-part="tool-call" className="my-2 rounded bg-muted/50 p-2">
        <div>
          <Badge variant="secondary"><span data-slot="tool-name">{p.name}</span></Badge> <code className="text-sm">{p.short}</code>
        </div>
        {p.fields.map((f) => (
          <div key={f.key} className="mt-1">
            <span className="text-xs text-muted-foreground">{f.key}:</span>
            <LongText text={f.value} />
          </div>
        ))}
        {!p.result && <p className="mt-1 text-sm text-muted-foreground">No result yet.</p>}
      </div>
      {p.result && <Result r={p.result} />}
    </>
  );
}

function EntryView({ e }: { e: Entry }) {
  switch (e.kind) {
    case "brief":
      return <Card entry="brief" className="bg-muted/30"><Label>The brief the agent got</Label><LongText text={e.text} /></Card>;
    case "turn":
      return (
        <Card entry="turn">
          <Label>{e.subagent ? "Subagent's assistant" : "Assistant"}</Label>
          {e.parts.map((p, i) => <TurnPart key={i} p={p} />)}
        </Card>
      );
    case "subagent-start":
      return (
        <Card entry="subagent-start" className="border-dashed">
          <Label>Subagent started</Label>
          <p><strong>{e.name}</strong></p>
          {e.description && <LongText text={e.description} />}
        </Card>
      );
    case "subagent-finish":
      return (
        <Card entry="subagent-finish" className="border-dashed">
          <Label>Subagent finished</Label>
          <p><strong>{e.name}</strong> {e.status || "finished"}</p>
          {e.summary && <LongText text={e.summary} />}
        </Card>
      );
    case "result":
      return (
        <Card entry="result" className={e.ok ? "" : "border-destructive"}>
          <Label>Final result</Label>
          <p>The agent call {e.ended}. Cost {cost(e.costUsd)}, tokens {tokens(e.tokensIn)} in, {tokens(e.tokensOut)} out.</p>
          {e.message && <LongText text={e.message} />}
        </Card>
      );
    case "unreadable":
      return <Card entry="unreadable"><Label>A line the page can't read</Label><LongText text={e.line} /></Card>;
  }
}

export function Transcript({ data: d }: TranscriptProps) {
  const s = d.stage;
  // An attempt that has no end, and isn't running, stopped before it finished: its cell died or was stopped (PBI 239).
  const stopped = !d.running && (s.status === "stopped" || (s.status === "started" && !s.ended_at));
  const entries = d.jsonl === null ? [] : readConversation(d.jsonl, { running: d.running });
  return (
    <div>
      <p><ItemName r={d.item} /></p>
      <h1 className="mb-3 text-2xl font-semibold">Transcript of {s.stage_id} attempt {s.attempt}</h1>
      {d.running && (
        <Alert className="mb-3"><AlertDescription>The attempt is still running. This is what the cell has uploaded so far: open the page again for newer turns.</AlertDescription></Alert>
      )}
      {stopped && <Alert className="mb-3"><AlertDescription>The attempt stopped before it finished.</AlertDescription></Alert>}
      {d.rawHref && d.jsonl !== null && <p className="mb-3"><A href={d.rawHref}>Raw JSON Lines file</A></p>}
      {d.jsonl === null ? (
        <p className="text-muted-foreground">
          {d.rawHref ? "The transcript can't be found: it's no longer stored." : "The transcript can't be found: this attempt has none the factory can serve."}
        </p>
      ) : entries.length ? entries.map((e, i) => <EntryView key={i} e={e} />) : <p className="text-muted-foreground">The transcript holds no messages yet.</p>}
    </div>
  );
}
