// PBI 326: a stage attempt's JSON Lines transcript read as a conversation, for the transcript page. Each line is one
// SDK message as runAgent wrote it (src/agent/run.ts), and each call starts with its brief line (src/agent/brief.ts).
// The attempt's calls follow each other in the file, as the cell's meter joins them.
//   brief            the brief a call was given
//   turn             an assistant turn: every assistant message with the same message id, as the SDK streams one
//                    message per content block, holding its thinking, text and tool calls in the order they came
//   subagent-start   a task_started system message for a subagent, named by its subagent_type: not a background
//                    shell's, a monitor's or a workflow's
//   subagent-finish  a task_notification for a subagent's task, named by its task's start
//   result           a call's final result: how it ended, its cost, tokens and message
//   unreadable       a line that isn't a JSON object, kept as its text
// A tool's result comes in a later user message of tool_result blocks, and is set on the call with its tool_use_id.
// No other message is part of the conversation: not the system init, a rate limit event, a task progress update nor
// a user message. Everything is kept as text: the page draws it as text, never as HTML.
// Kept free of React, and under src, so Node's tests, the SPA (web/src/transcript.ts) and the 7400 dashboard read it.
import { BRIEF_TYPE } from "../agent/brief.ts";

export type ToolResult = { text: string; error: boolean };
export type Field = { key: string; value: string };
export type Part =
  /** `text` is null when the model's thinking was redacted, so its words were withheld. */
  | { kind: "thinking"; text: string | null }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; short: string; fields: Field[]; result: ToolResult | null };
export type Entry =
  | { kind: "brief"; text: string }
  /** `subagent` is true for a turn a subagent took, which the SDK marks with the tool call that started it. */
  | { kind: "turn"; id: string; subagent: boolean; parts: Part[] }
  | { kind: "subagent-start"; name: string; description: string }
  | { kind: "subagent-finish"; name: string; status: string; summary: string }
  | { kind: "result"; ended: string; ok: boolean; costUsd: number; tokensIn: number; tokensOut: number; message: string }
  | { kind: "unreadable"; line: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Each tool's main field, which its call shows as the short form of its input. */
const MAIN_FIELD: Record<string, string> = {
  Bash: "command", Read: "file_path", Edit: "file_path", MultiEdit: "file_path", Write: "file_path", NotebookEdit: "notebook_path",
  Grep: "pattern", Glob: "pattern", WebFetch: "url", WebSearch: "query", Agent: "description", Task: "description",
  Skill: "skill", ToolSearch: "query",
};
const SHORT_CHARS = 160;

const asText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2) ?? String(v));

/**
 * A tool call's input as a short form and the rest. The short form is the tool's main field, or for a tool the page
 * doesn't know its first text field, cut to its first line. The rest are the input's other fields, each as text, and
 * the main field too when its short form leaves some of it out.
 */
export function shortInput(tool: string, input: unknown): { short: string; fields: Field[] } {
  if (!isObj(input)) return input === undefined || input === null ? { short: "", fields: [] } : { short: "", fields: [{ key: "input", value: asText(input) }] };
  const keys = Object.keys(input);
  const main = MAIN_FIELD[tool] && typeof input[MAIN_FIELD[tool]] === "string" ? MAIN_FIELD[tool] : keys.find((k) => typeof input[k] === "string");
  const whole = main === undefined ? "" : str(input[main]);
  const first = whole.split("\n")[0];
  const short = first.length > SHORT_CHARS ? `${first.slice(0, SHORT_CHARS)}…` : first !== whole ? `${first} …` : first;
  const fields = keys.filter((k) => k !== main || short !== whole).map((k) => ({ key: k, value: asText(input[k]) }));
  return { short, fields };
}

/** A tool result's content as text: a string as it is, and each block of a list, text as its text. */
function resultText(content: unknown): string {
  const s = typeof content === "string" ? content
    : Array.isArray(content) ? content.map((b) => (isObj(b) && b.type === "text" ? str(b.text) : isObj(b) ? `[${str(b.type) || "block"}]` : asText(b))).join("\n")
    : content === undefined || content === null ? "" : asText(content);
  // Claude Code wraps a tool's error in this tag, which says no more than the result's error mark does.
  return /^<tool_use_error>([\s\S]*)<\/tool_use_error>$/.exec(s)?.[1] ?? s;
}

/** How a call ended, as its final result says: the SDK's subtype, and whether a success carries an API error. */
function ended(subtype: string, isError: boolean): string {
  if (subtype === "success") return isError ? "failed with an error" : "succeeded";
  if (subtype === "error_max_turns") return "ran out of turns";
  if (subtype === "error_max_budget_usd") return "ran out of budget";
  if (subtype === "error_during_execution") return "failed with an error";
  if (subtype === "error_max_structured_output_retries") return "couldn't give its structured output";
  return `ended with ${subtype || "no reason given"}`;
}

/** A final result. Its cost and tokens are summed over its models, as runAgent sums them (src/agent/run.ts). */
function finalResult(m: Obj): Entry {
  const models = isObj(m.modelUsage) ? Object.values(m.modelUsage).filter(isObj) : [];
  const usage = isObj(m.usage) ? m.usage : {};
  const subtype = str(m.subtype);
  const isError = m.is_error === true;
  return {
    kind: "result", ended: ended(subtype, isError), ok: subtype === "success" && !isError,
    costUsd: models.length ? models.reduce((s, u) => s + num(u.costUSD), 0) : num(m.total_cost_usd),
    tokensIn: models.length ? models.reduce((s, u) => s + num(u.inputTokens) + num(u.cacheReadInputTokens) + num(u.cacheCreationInputTokens), 0)
      : num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens),
    tokensOut: models.length ? models.reduce((s, u) => s + num(u.outputTokens), 0) : num(usage.output_tokens),
    message: subtype === "success" ? str(m.result) : Array.isArray(m.errors) ? m.errors.map(asText).join("\n") : "",
  };
}

/**
 * The transcript's entries, in the order they happened. A running attempt's upload can end part-way through a line,
 * so its last line is left out when the file doesn't end with a newline.
 */
export function readConversation(jsonl: string, o: { running: boolean }): Entry[] {
  const lines = jsonl.split("\n");
  // The text after the last newline: empty for a whole file, a line cut short for one still being written.
  if (o.running || lines.at(-1) === "") lines.pop();
  const out: Entry[] = [];
  const turns = new Map<string, Extract<Entry, { kind: "turn" }>>();
  const calls = new Map<string, Extract<Part, { kind: "tool" }>>();
  const tasks = new Map<string, string>();
  let anon = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    let m: unknown;
    try {
      m = JSON.parse(line);
    } catch {
      m = undefined;
    }
    if (!isObj(m)) {
      out.push({ kind: "unreadable", line });
      continue;
    }
    if (m.type === BRIEF_TYPE) out.push({ kind: "brief", text: str(m.prompt) });
    else if (m.type === "assistant" && isObj(m.message)) {
      const msg = m.message;
      const id = str(msg.id) || `#${++anon}`;
      let t = turns.get(id);
      if (!t) {
        t = { kind: "turn", id, subagent: typeof m.parent_tool_use_id === "string", parts: [] };
        turns.set(id, t);
        out.push(t);
      }
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: str(msg.content) }];
      for (const b of blocks.filter(isObj)) {
        if (b.type === "thinking") t.parts.push({ kind: "thinking", text: str(b.thinking) });
        else if (b.type === "redacted_thinking") t.parts.push({ kind: "thinking", text: null });
        else if (b.type === "text") t.parts.push({ kind: "text", text: str(b.text) });
        else if (b.type === "tool_use" || b.type === "server_tool_use" || b.type === "mcp_tool_use") {
          const name = str(b.name);
          const call: Extract<Part, { kind: "tool" }> = { kind: "tool", id: str(b.id), name, ...shortInput(name, b.input), result: null };
          t.parts.push(call);
          if (call.id) calls.set(call.id, call);
        }
      }
    } else if (m.type === "user" && isObj(m.message) && Array.isArray(m.message.content)) {
      for (const b of m.message.content.filter(isObj)) {
        const call = b.type === "tool_result" ? calls.get(str(b.tool_use_id)) : undefined;
        if (call) call.result = { text: resultText(b.content), error: b.is_error === true };
      }
    } else if (m.type === "system" && m.subtype === "task_started") {
      // A background shell, monitor or workflow starts a task too, and only a subagent's is a subagent task: the Bash
      // call behind a background shell already shows as a tool call with its result.
      if (!str(m.subagent_type) && m.task_type !== "local_agent") continue;
      const name = str(m.subagent_type) || "subagent";
      tasks.set(str(m.task_id), name);
      out.push({ kind: "subagent-start", name, description: str(m.description) });
    } else if (m.type === "system" && m.subtype === "task_notification") {
      // The finish of a task that wasn't a subagent's is left out with its start.
      const name = tasks.get(str(m.task_id));
      if (name !== undefined) out.push({ kind: "subagent-finish", name, status: str(m.status), summary: str(m.summary) });
    } else if (m.type === "result") out.push(finalResult(m));
  }
  return out;
}

/** How much of a long text shows before it's opened. */
export const PREVIEW_LINES = 10;
export const PREVIEW_CHARS = 1000;

/**
 * A text cut to its first lines, and to its first characters when those run long, so a long one shows a few lines
 * until opened. `rest` is what follows the head, and `more` says how much that is. A short text is all head.
 */
export function clip(s: string, lines = PREVIEW_LINES, chars = PREVIEW_CHARS): { head: string; rest: string; more: string } {
  let at = -1;
  for (let k = 0; k < lines; k++) {
    at = s.indexOf("\n", at + 1);
    if (at < 0) break;
  }
  const cut = Math.min(at < 0 ? s.length : at, chars);
  const rest = s.slice(s[cut] === "\n" ? cut + 1 : cut);
  if (rest.trim() === "") return { head: s, rest: "", more: "" };
  const restLines = rest.split("\n").length;
  const more = restLines > 1 || s[cut] === "\n" ? `${restLines.toLocaleString("en-US")} more ${restLines === 1 ? "line" : "lines"}`
    : `${rest.length.toLocaleString("en-US")} more characters`;
  return { head: s.slice(0, cut), rest, more };
}
