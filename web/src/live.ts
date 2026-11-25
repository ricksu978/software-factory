// Floor's live updates (redesign step 8c, 2026-11-07 design §05 and §07, PBI 280), kept free of React and of the
// browser's globals so it runs in Node against stand-ins, as the shell does.
//   - Floor follows the factory's events: it reads GET /bff/v1/events through the shell's call, a text/event-stream
//     whose `data:` lines are the API's /v1/events notifications. An event reads the floor again, after SETTLE_MS, so
//     a burst of events reads it once.
//   - The API ends each stream after five minutes, and a stream can drop. When one ends, Floor first checks the session
//     at /auth/session, so a session that ended sends the browser to sign in at once rather than after the next
//     attempt. Then it opens a new stream after RETRY_MS, waiting twice as long after each attempt in a row that
//     fails, or each stream that ends within RETRY_MAX_MS of opening, up to RETRY_MAX_MS, so it doesn't hammer a BFF
//     that can't open one. Once a new stream is open, Floor reads the floor again, to catch up on what it missed.
//     A 401 is the shell's to handle (it sends the browser to /auth/login), and Floor stops following.
//   - A worker that is ticking writes no event, so Floor also reads the floor every POLL_MS with no event.
//   - While the Controls' Reason field has focus or holds text, Floor reads nothing, so the reason isn't lost. It
//     catches up once the field is empty and has lost focus. Once the factory accepts the Controls form, the page
//     empties the field and says so (emptiedOnAccept), since the reason has been sent and Floor would otherwise stay
//     held back by text no one is still writing.
// The browser's Floor page starts it with the real clock, and the scenarios with a fake one. A timer's callback
// returns nothing long-lived, since a fake clock waits for what it returns.
import { readFloor, type Call, type FloorData, type Submitted } from "./api.ts";

export const EVENTS_PATH = "/bff/v1/events";
/** How long Floor waits after an event for more before it reads the floor. */
export const SETTLE_MS = 250;
/** The longest a steady run of events puts a read off. */
export const SETTLE_MAX_MS = 1_000;
/** The wait before the first attempt to open a new stream, and the least between one attempt and the next. */
export const RETRY_MS = 1_000;
/** The longest wait between attempts to open a stream. */
export const RETRY_MAX_MS = 15_000;
/** How often Floor reads the floor with no event, so it sees a heartbeat go stale. */
export const POLL_MS = 30_000;

/** The timers Floor sets, and the time. The browser's is the real clock. */
export type LiveClock = {
  now(): Date;
  setTimeout(fn: () => unknown, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type LiveFloorEnv = {
  call: Call;
  clock: LiveClock;
  /** Gets each fresh read of the floor, for Floor to draw. */
  onFloor(data: FloorData): void;
};

/** What the Controls' Reason field holds, and whether it has focus. */
export type ReasonField = { value: string; focused: boolean };

export type LiveFloor = {
  /** Tells Floor what the Reason field holds and whether it has focus, each time either changes. */
  reasonField(field: ReasonField): void;
  /** Stops following the events: closes the stream and clears every timer. */
  stop(): void;
};

/** Starts following the factory's events for Floor, which has already drawn from one read. */
export function startLiveFloor(env: LiveFloorEnv): LiveFloor {
  const { call, clock } = env;
  let stopped = false;
  let field: ReasonField = { value: "", focused: false };
  /** A read Floor held back while the Reason field was in use. */
  let owed = false;
  let reading = false;
  let readAgain = false;
  let stream: AbortController | undefined;
  /** Attempts to open a stream in a row that failed, or streams that ended soon after they opened. */
  let failures = 0;
  const timers: { settle?: unknown; settleFirst?: number; retry?: unknown; poll?: unknown } = {};
  const now = () => clock.now().getTime();
  const held = () => field.focused || field.value !== "";
  const clear = (h: unknown) => h !== undefined && clock.clearTimeout(h);

  function refresh(): void {
    if (stopped) return;
    if (held()) {
      owed = true;
      return;
    }
    owed = false;
    if (reading) {
      readAgain = true;
      return;
    }
    reading = true;
    readFloor(call).then(
      (data) => {
        if (stopped) return;
        // The field may have come into use while the read was under way: drawing now would lose the reason.
        if (held()) owed = true;
        else env.onFloor(data);
      },
      () => {},
    ).finally(() => {
      reading = false;
      if (readAgain) {
        readAgain = false;
        refresh();
      }
    });
  }

  /** An event: reads the floor once the burst it's part of has settled. */
  function event(): void {
    if (stopped) return;
    clear(timers.settle);
    timers.settleFirst ??= now();
    const wait = Math.max(0, Math.min(SETTLE_MS, timers.settleFirst + SETTLE_MAX_MS - now()));
    timers.settle = clock.setTimeout(() => {
      timers.settle = undefined;
      timers.settleFirst = undefined;
      refresh();
    }, wait);
  }

  function poll(): void {
    timers.poll = clock.setTimeout(() => {
      if (stopped) return;
      refresh();
      poll();
    }, POLL_MS);
  }

  function retry(): void {
    if (stopped) return;
    const wait = Math.min(RETRY_MS * 2 ** failures, RETRY_MAX_MS);
    failures++;
    clear(timers.retry);
    timers.retry = clock.setTimeout(() => {
      timers.retry = undefined;
      void connect(true);
    }, wait);
  }

  /** Reads the stream's `data:` lines, each an event, until it ends. */
  async function follow(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let rest = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped) break;
        rest += dec.decode(value, { stream: true });
        const lines = rest.split(/\r?\n/);
        rest = lines.pop() ?? "";
        if (lines.some((l) => l.startsWith("data:"))) event();
      }
    } catch {
      // A stream that drops ends here as one the factory ends does.
    } finally {
      if (stopped) void reader.cancel().catch(() => {});
    }
  }

  async function connect(again: boolean): Promise<void> {
    if (stopped) return;
    const ctl = new AbortController();
    stream = ctl;
    let r: Response;
    try {
      r = await call(EVENTS_PATH, { headers: { accept: "text/event-stream" }, signal: ctl.signal });
    } catch {
      return retry();
    }
    if (stopped) {
      ctl.abort();
      return;
    }
    if (r.status === 401) return stop();
    if (!r.ok || !r.body) {
      void r.body?.cancel().catch(() => {});
      return retry();
    }
    const opened = now();
    if (again) refresh();
    await follow(r.body);
    if (stopped) return;
    if (now() - opened >= RETRY_MAX_MS) failures = 0;
    // A session that ended goes to sign-in now, through the shell, rather than after the next attempt's wait.
    const session = await call("/auth/session").catch(() => null);
    if (session?.status === 401) return stop();
    retry();
  }

  function stop(): void {
    stopped = true;
    clear(timers.settle);
    clear(timers.retry);
    clear(timers.poll);
    stream?.abort();
  }

  void connect(false);
  poll();
  return {
    reasonField(f: ReasonField) {
      field = { ...f };
      if (owed && !held()) refresh();
    },
    stop,
  };
}

/**
 * Runs `empty` once the factory accepts a Controls form `sent`, before the page takes the answer, so the page can empty
 * the Reason field and tell Floor: the reason was sent, so it no longer holds Floor back. A form the factory refuses or
 * that fails keeps its reason, for the operator to send again.
 */
export function emptiedOnAccept<T>(sent: Promise<Submitted<T>>, empty: () => void): Promise<Submitted<T>> {
  return sent.then((r) => {
    if (r.outcome === "accepted") empty();
    return r;
  });
}
