// The API's live event stream (2026-11-07 design §04 and §05). Every open stream is fed by one LISTEN factory_events
// client, so open tabs never hold more than one pool connection. Each stream ends after five minutes, so a removed
// user's reconnect meets the per-request user check.
import type pg from "pg";

export const STREAM_MS = 5 * 60_000;

type Subscriber = { send(payload: string): void; end(): void };

export type EventFeed = {
  /** Starts the shared LISTEN once. Throws when the database can't be reached. */
  listen(): Promise<void>;
  /** Feeds `s` every event until the returned function is called or the feed ends it. */
  subscribe(s: Subscriber): () => void;
  /** Ends every stream and releases the LISTEN client. */
  close(): Promise<void>;
};

export function eventFeed(pool: pg.Pool): EventFeed {
  const subs = new Set<Subscriber>();
  let listener: Promise<pg.PoolClient> | null = null;
  const endAll = () => {
    for (const s of subs) s.end();
    subs.clear();
  };
  return {
    async listen() {
      listener ??= (async () => {
        const c = await pool.connect();
        c.on("notification", (m) => {
          if (m.channel === "factory_events") for (const s of subs) s.send(m.payload ?? "{}");
        });
        // A checked-out client has no pool error handler, so a dropped connection would otherwise crash the process.
        // Each browser reconnects and the next stream LISTENs again.
        c.on("error", (e) => {
          console.error("API event listener lost its connection:", e.message);
          listener = null;
          c.release(true);
          endAll();
        });
        try {
          await c.query("listen factory_events");
        } catch (e) {
          c.release(true);
          listener = null;
          throw e;
        }
        return c;
      })();
      await listener;
    },
    subscribe(s) {
      subs.add(s);
      return () => subs.delete(s);
    },
    async close() {
      endAll();
      const c = await listener?.catch(() => null);
      listener = null;
      c?.release(true);
    },
  };
}
