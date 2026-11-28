// PBI 439: the readiness check the owner's accepted rewrite is owed. Accepting a rewrite on the dashboard records a
// `rewrite_accepted` event, which wakes the worker through Postgres's LISTEN/NOTIFY, so the item is checked again at
// once, not on its board's next poll. The worker's tick runs the same check too, in case a notification was missed.
import pg from "pg";
import { markRechecked, REWRITE_ACCEPTED, rechecksOwed } from "../store/rewrites.ts";

/**
 * Polls each board with an accepted rewrite owed a readiness check, with that board's `polls` entry, and marks the
 * rewrites rechecked whatever the poll's outcome. A poll that fails is logged, and the board's regular poll checks
 * the item again, so a failing board isn't polled on every tick while it fails.
 */
export async function recheckAccepted(pool: pg.Pool, polls: Map<string, () => Promise<unknown>>, log: Pick<Console, "error"> = console): Promise<void> {
  for (const [sourceId, ids] of await rechecksOwed(pool)) {
    const poll = polls.get(sourceId);
    if (!poll) continue;
    try {
      await poll();
    } catch (e) {
      log.error(`rechecking the rewrites accepted on source ${sourceId} failed, so its regular poll checks them again:`, e);
    } finally {
      await markRechecked(pool, ids);
    }
  }
}

/**
 * Calls `onAccepted` each time an event of kind `rewrite_accepted` is appended, on a connection of its own, with its
 * pool's settings, that LISTENs to factory_events. The connection sits outside the pool, as the worker's lock connection
 * does, so the pool never has a client out for it and the pool's size is the worker's work alone. A listener whose
 * connection drops logs it and stops: the worker's tick still runs the recheck. Returns the call that closes it.
 */
export async function onRewriteAccepted(pool: pg.Pool, onAccepted: () => void, log: Pick<Console, "error"> = console): Promise<() => Promise<void>> {
  const c = new pg.Client({ ...(pool.options as pg.ClientConfig), keepAlive: true });
  let closing = false;
  c.on("notification", (m) => {
    if (m.channel !== "factory_events") return;
    try {
      if ((JSON.parse(m.payload ?? "{}") as { kind?: string }).kind === REWRITE_ACCEPTED) onAccepted();
    } catch {
      // A payload that isn't JSON isn't an acceptance.
    }
  });
  c.on("error", (e) => {
    if (closing) return;
    log.error("The worker's listener for accepted rewrites lost its connection, so they're rechecked on its tick:", e.message);
  });
  const close = async () => {
    if (closing) return;
    closing = true;
    await c.end().catch(() => {});
  };
  try {
    await c.connect();
    await c.query("listen factory_events");
  } catch (e) {
    await close();
    throw e;
  }
  return close;
}
