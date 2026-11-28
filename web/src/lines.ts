// The SPA's sentences (redesign step 8b): the words today's pages in src/http/views.ts put together, kept free of React
// so Node's tests read them directly. Numbers and times come from src/http/format.ts, as today's pages format them.
import { localTime } from "../../src/http/format.ts";
import type { ActivityData, ClaimKey, MainBreak } from "./api.ts";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** How long ago `since` was, as today's Floor says it: minutes, hours under two days, then days. */
export function age(since: string | null, now: Date): string {
  if (!since) return "";
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(since)) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

/** A heartbeat older than this means the worker's scheduler has stopped ticking (PBI 280). */
export const STALE_HEARTBEAT_MS = 60_000;

/** When the worker last ticked (PBI 158), as Floor's line beside the outbox count says it. */
export function heartbeatLine(beat: string | null, now: Date): string {
  if (!beat) return "The worker hasn't ticked yet.";
  const ms = now.getTime() - Date.parse(beat);
  return `The worker last ticked ${ms < 60_000 ? "under a minute" : age(beat, now)} ago.`;
}

/**
 * Floor's banner when the worker's heartbeat is more than a minute old or missing (PBI 280), so a stopped worker
 * doesn't look like a quiet factory. A floor that carries no heartbeat at all (undefined) gets no banner.
 */
export function schedulerBanner(beat: string | null | undefined, now: Date): string | null {
  if (beat === undefined) return null;
  if (beat !== null && now.getTime() - Date.parse(beat) <= STALE_HEARTBEAT_MS) return null;
  return `Scheduler not ticking. ${heartbeatLine(beat, now)}`;
}

/** Why a blocked item waits. Each blocker is plain "#N", since GitHub may list one from another repo. */
export function blockedReason(deps: string[]): string {
  const refs = deps.map((d) => `#${d}`);
  const names = refs.length === 1 ? refs[0] : `${refs.slice(0, -1).join(", ")} and ${refs[refs.length - 1]}`;
  return `Waits on ${names}, ${refs.length === 1 ? "which is" : "which are"} still open. It starts once ${refs.length === 1 ? "it closes" : "they close"}.`;
}

/** Floor's note on an item's claim key (PBI 320): its priority, and its final-stage group, each with where it comes from. */
export function standing(k: ClaimKey): string {
  const from = k.priorityFrom ? `, from #${k.priorityFrom.externalId}` : "";
  const group = k.finalStage ? `, final-stage${k.finalStageFrom ? ` because of #${k.finalStageFrom.externalId}` : ""}` : "";
  return `priority ${k.priority}${from}${group}`;
}

/** Run detail's line on the claim key (PBI 320, PBI 378). Neither "Final-stage" nor "bug label" shows where it doesn't apply. */
export function claimLines(k: ClaimKey): string {
  const priority = k.priorityFrom
    ? `Priority ${k.priority}, from #${k.priorityFrom.externalId}, which depends on it. Its own priority on the board is ${k.own}.`
    : `Priority ${k.priority}.`;
  const group = !k.finalStage ? ""
    : k.finalStageFrom ? ` Final-stage because #${k.finalStageFrom.externalId} depends on it, so it's claimed ahead of other work while that dependency stands.`
    : " Final-stage: its PR is open and it's in the review loop, so it's claimed ahead of other work.";
  const bug = !k.bug ? ""
    : k.finalStage ? ` Carries the bug label, so it's claimed before the items at priority ${k.priority} in the final-stage group that don't.`
    : k.priority === 1 ? " Carries the bug label, so it's claimed before the priority-1 items outside the final-stage group that don't."
    : " Carries the bug label, which puts it first only in the final-stage group or at priority 1.";
  return `${priority}${group}${bug}`;
}

/** The banner for a drain (PBI 316): the cells still running, then that it's done. With no count, its reason alone. */
export function drainLine(reason: string, running: number | undefined): string {
  if (running === undefined) return `Draining: ${reason}`;
  const text = running > 0
    ? `Draining: ${plural(running, "cell", "cells")} still running.`
    : "Drain done. No cell is running, so it's safe to restart the factory or stop Docker.";
  return `${text} Reason: ${reason}.`;
}

/** The banner for a restart being prepared (PBI 140, PBI 302). The factory stops no cell (PBI 300). */
export function restartLine(r: { running: number; reason?: string }): string {
  const text = r.running > 0
    ? `Preparing to restart: ${plural(r.running, "cell", "cells")} still running. The factory won't stop ${r.running === 1 ? "it" : "them"}.`
    : "Ready to restart. No cell is running, so it's safe to restart the factory or stop Docker.";
  return r.reason ? `${text} Reason: ${r.reason}.` : text;
}

/** The first line of Floor's main-red banner (PBI 255). The factory fixes first only a break an item is charged with. */
export function mainRedLead(rows: MainBreak[]): string {
  const branches = [...new Set(rows.map((r) => r.branch))].join(" and ");
  const fixes = rows.some((r) => r.charged !== null) ? "The factory fixes it before it builds anything else, and an" : "An";
  return `${branches} is red. ${fixes} item merged onto it meanwhile waits for it to pass again.`;
}

/** When the factory last re-checked a Failed item (PBI 369): Floor's short form (PBI 430), or Run detail's sentence. */
export function recheckLine(at: string | null, zone: string, sentence: boolean): string {
  const when = at ? localTime(new Date(at), zone) : null;
  if (!sentence) return `Failed on main, ${when ? `last re-checked at ${when}` : "not yet re-checked"}`;
  const tail = "The factory re-checks it every few hours and moves it back to Accepted once its merge no longer counts as breaking main.";
  return when ? `Last re-checked at ${when}. ${tail}` : `It hasn't been re-checked yet. ${tail}`;
}

/** Only a move between states shows where it came from and went. An SOP move (PBI 173) shows its old and new versions. */
const MOVES = new Set(["transition", "override", "sop_moved"]);

/** Activity's Move cell: a move, a setting change with who made it and why (PBI 175, PBI 176), or nothing. */
export function moveLine(e: ActivityData["events"][number]): string {
  if (e.kind === "setting") {
    return `${e.actor ?? ""} changed ${e.setting ?? ""} from ${e.from ?? "not set"} to ${e.to ?? "not set"}${e.reason ? ` because ${e.reason}` : ""}`;
  }
  if (!MOVES.has(e.kind)) return "";
  return `${e.from ?? ""} → ${e.to ?? ""}${e.kind === "transition" && e.event ? ` (${e.event})` : ""}`;
}

/** Dollars to the cent, as the Phase 0 report shows its sums. */
export const usd = (n: number) => `$${n.toFixed(2)}`;
/** A readiness spend costs fractions of a cent, so it shows to four places. */
export const judgeUsd = (n: number) => `$${n.toFixed(4)}`;

/** The Phase 0 report's summary of the merged PRs' costs. */
export function summary(costs: number[]): string {
  const total = costs.reduce((a, b) => a + b, 0);
  return `${plural(costs.length, "merged PR", "merged PRs")}, ${usd(total)} in all, ${usd(costs.length ? total / costs.length : 0)} each on average.`;
}

/** The API's error, such as "that item isn't waiting for this decision", as a sentence the page shows. */
export function sentence(error: string): string {
  const s = error.trim();
  if (!s) return "The factory refused it.";
  const capital = s[0].toUpperCase() + s.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}
