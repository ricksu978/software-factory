// The pieces Floor, Run detail, Phase 0 and Activity share (redesign step 8b): an item's issue number and title, its
// PR, a banner, a cost cell and a time, each as today's pages in src/http/views.ts draw it.
import type { FormEvent, ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { TableCell } from "@/components/ui/table";
import { issueUrl } from "../../../src/core/links.ts";
import { cost, localTime } from "../../../src/http/format.ts";
import type { ClaimKey, Issue, OpenPr } from "../api.ts";
import { standing } from "../lines.ts";
import { runPath } from "../routes.ts";

/**
 * "#N" for an item's issue, linked to it on GitHub when its repo is known. A number that isn't one, or an unknown repo,
 * shows as plain text, since a link to the wrong issue is worse than none. An event with no item shows nothing.
 */
export function IssueRef({ external_id, repo }: { external_id: string | null; repo: string | null }) {
  if (external_id === null) return null;
  const url = issueUrl(repo, external_id);
  return url ? <A href={url}>#{external_id}</A> : <>#{external_id}</>;
}

/** An item as a page names it: "#N", then its title opening its Run detail. */
export function ItemName({ r }: { r: Issue & { id: string; title: string } }) {
  return (
    <>
      <IssueRef external_id={r.external_id} repo={r.repo} /> <a className="font-medium underline-offset-4 hover:underline" href={runPath(r.id)}>{r.title}</a>
    </>
  );
}

/**
 * " PR #N" for an InReview item, linked to the PR its open run holds (PBI 145). With the address or the number missing
 * there's no link, since a guessed address may point at the wrong PR.
 */
export function PrLink({ r }: { r: OpenPr & { state: string } }) {
  if (r.state !== "InReview" || !r.pr_url || r.pr_number == null) return null;
  return <> <A href={r.pr_url}>PR #{r.pr_number}</A></>;
}

/** Floor's note on an item's claim key: a "bug" badge for a bug item (PBI 378), then its priority and group (PBI 320). */
export function Standing({ k }: { k: ClaimKey | undefined }) {
  if (!k) return null;
  return (
    <>
      {k.bug && <> <Badge variant="destructive">bug</Badge></>} <span className="text-muted-foreground">{standing(k)}</span>
    </>
  );
}

/** A banner: the factory's state, or something that needs attention. Its whole text is what it says. */
export function Banner({ children }: { children: ReactNode }) {
  return (
    <Alert className="mb-3 border-amber-500/50">
      <AlertDescription className="text-foreground">{children}</AlertDescription>
    </Alert>
  );
}

/** What the factory said about the last form sent, such as why it refused it. */
export function Message({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return (
    <Alert variant="destructive" className="mb-3">
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}

/** A Cost cell: the cost to the cent, with the exact figure in its title so hovering shows it (PBI 189, PBI 263). */
export function CostCell({ usd }: { usd: string | number | null }) {
  return <TableCell title={`$${usd ?? 0}`}>{cost(usd)}</TableCell>;
}

/** A time to the minute in the zone, with its full ISO form in the markup. */
export function Time({ at, zone }: { at: string; zone: string }) {
  return <time dateTime={new Date(at).toISOString()}>{localTime(new Date(at), zone)}</time>;
}

/** A Split parent's children (PBI 227), in order: each "#N" linking to its issue, its title, and its state. */
export function SplitInto({ children }: { children: { externalId: string; title: string; url: string; state: string | null }[] }) {
  return (
    <ol className="ml-6 list-decimal">
      {children.map((k) => (
        <li key={k.externalId}>
          {/^https?:\/\//.test(k.url) ? <A href={k.url}>#{k.externalId}</A> : <>#{k.externalId}</>} {k.title}{" "}
          <span className="text-muted-foreground">{k.state ?? "Not in the factory"}</span>
        </li>
      ))}
    </ol>
  );
}

/** A section heading as Floor and Run detail head their parts. */
export function H2({ children }: { children: ReactNode }) {
  return <h2 className="mt-6 mb-2 text-lg font-semibold">{children}</h2>;
}

/**
 * Hands a form's submit to `submit` with the text of the button pressed and the named field as typed. The browser
 * sends nothing itself, and with no `submit`, as when react-dom/server renders the page, a submit does nothing.
 */
export function onSubmitWith(field: string, submit: ((button: string, value: string) => void) | undefined) {
  return (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const button = (e.nativeEvent as SubmitEvent).submitter?.textContent?.trim() ?? "";
    const value = new FormData(e.currentTarget).get(field);
    submit?.(button, typeof value === "string" ? value : "");
  };
}

/** The muted note a page shows in place of an empty list or table. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground">{children}</p>;
}

/** A link inside a page's text. */
export function A({ href, children }: { href: string; children: ReactNode }) {
  return <a className="text-primary underline-offset-4 hover:underline" href={href}>{children}</a>;
}
