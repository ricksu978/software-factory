// The SPA's page once the shell has found a session and a user (redesign steps 8a and 8b): the header, then the page
// the address names (web/src/routes.ts). Each page draws from one read of the factory, and reads it again once a form
// it sent is accepted. Live updates come in a later step.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { readActivity, readFloor, readItem, readPhase0, type Call, type FormName, type ItemData, type Submitted } from "./api.ts";
import { submitAnswer, submitFloorControls, submitItemControls, submitSignOff } from "./forms.ts";
import { Activity } from "./pages/Activity.tsx";
import { Floor } from "./pages/Floor.tsx";
import { Phase0 } from "./pages/Phase0.tsx";
import { RunDetail } from "./pages/RunDetail.tsx";
import { PATHS, routeOf } from "./routes.ts";

/** The viewer's own time zone, as their browser tells it, or UTC when it can't. */
const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** What a page holds: its data once read, why the read failed, and what the factory said about the last form sent. */
type Loaded<T> = { data?: T; error?: string; message?: string | null };

/** Reads a page's data once, and offers a way to take what a submit handler did. */
function useRead<T>(read: () => Promise<T>, key: string) {
  const [state, setState] = useState<Loaded<T>>({});
  useEffect(() => {
    let live = true;
    setState({});
    read().then((data) => live && setState({ data }), (e: unknown) => live && setState({ error: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
    // `key` names what's read, so the read runs again only when that changes, not on every new `read` closure.
  }, [key]);
  const took = useCallback((sent: Promise<Submitted<T>>) => {
    sent.then((r) => setState((s) => r.outcome === "accepted" ? { data: r.data, message: null }
      : { ...s, message: r.outcome === "failed" ? r.message : `${r.field} can't be empty.` }),
    (e: unknown) => setState((s) => ({ ...s, message: `It wasn't sent: ${e instanceof Error ? e.message : String(e)}` })));
  }, []);
  return [state, took] as const;
}

function Shown<T>({ state, what, children }: { state: Loaded<T>; what: string; children: (data: T) => ReactNode }) {
  if (state.error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>The {what} couldn't be read</AlertTitle>
        <AlertDescription>{state.error}</AlertDescription>
      </Alert>
    );
  }
  return state.data === undefined ? <p className="text-muted-foreground">{`Reading the ${what}…`}</p> : children(state.data);
}

function FloorPage({ call }: { call: Call }) {
  const [state, took] = useRead(() => readFloor(call), "floor");
  return (
    <Shown state={state} what="floor">
      {(data) => <Floor data={data} zone={viewerZone()} now={new Date()} message={state.message} onSubmit={(_f, b, v) => took(submitFloorControls(call, b, v))} />}
    </Shown>
  );
}

const ITEM_FORMS: Record<FormName, (call: Call, item: ItemData, button: string, value: string) => Promise<Submitted<ItemData>>> = {
  Controls: submitItemControls, "Sign off": submitSignOff, Answer: submitAnswer,
};

function RunDetailPage({ call, id }: { call: Call; id: string }) {
  const [state, took] = useRead(() => readItem(call, id), `item ${id}`);
  return (
    <Shown state={state} what="item">
      {(data) => <RunDetail data={data} zone={viewerZone()} now={new Date()} message={state.message} onSubmit={(f, b, v) => took(ITEM_FORMS[f](call, data, b, v))} />}
    </Shown>
  );
}

function Phase0Page({ call }: { call: Call }) {
  const [state] = useRead(() => readPhase0(call), "phase0");
  return <Shown state={state} what="Phase 0 report">{(data) => <Phase0 data={data} />}</Shown>;
}

function ActivityPage({ call }: { call: Call }) {
  const [state] = useRead(() => readActivity(call), "activity");
  return <Shown state={state} what="activity log">{(data) => <Activity data={data} />}</Shown>;
}

function Page({ call, path }: { call: Call; path: string }) {
  const route = routeOf(path);
  if (route.page === "floor") return <FloorPage call={call} />;
  if (route.page === "item") return <RunDetailPage call={call} id={route.id} />;
  if (route.page === "phase0") return <Phase0Page call={call} />;
  if (route.page === "activity") return <ActivityPage call={call} />;
  return (
    <Alert>
      <AlertTitle>No such page</AlertTitle>
      <AlertDescription><a className="text-primary underline-offset-4 hover:underline" href={PATHS.floor}>Floor</a> lists every item.</AlertDescription>
    </Alert>
  );
}

export function App({ call, path = "/" }: { call: Call; path?: string }) {
  const [subject, setSubject] = useState<string>();

  useEffect(() => {
    let live = true;
    call("/auth/session")
      .then(async (r) => {
        if (r.ok && live) setSubject(((await r.json()) as { subject: string }).subject);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [call]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <nav className="flex items-center gap-4">
          <span className="text-lg font-semibold">Software factory</span>
          <a className="underline-offset-4 hover:underline" href={PATHS.floor}>Floor</a>
        </nav>
        {subject && <Badge variant="secondary">Signed in as {subject}</Badge>}
      </header>
      <main className="mx-auto max-w-6xl p-6">
        <Page call={call} path={path} />
      </main>
    </div>
  );
}
