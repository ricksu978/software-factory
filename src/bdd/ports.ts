// Ports for the BDD suite's steps (PBI 390 AC-3). Scenarios run in parallel workers on one machine, so no step starts
// a server on, or connects to, a port fixed in its code. A step that starts a server takes a free port. A scenario may
// still name the ports it's about ("the cell API service starts on port 7401"): each port a scenario names stands for
// a free port of its own, the same one for the whole scenario, so every step that starts a server on it or connects
// to it reaches the same server, and never another worker's or a program that really holds the named port.
import { createServer } from "node:net";

/** The lowest port freePort hands out. Ports below 32768 lie under the range Linux (32768-60999), macOS and Windows
 * (49152-65535) take outgoing connections' ports from, so no connection to Postgres or a fetch can be holding one when
 * a step starts its server on it, as one held port 41617 in the gap between being picked and being listened on. */
export const LOWEST = 20_000;
/** One above the highest port freePort hands out. */
export const ABOVE = 32_768;

const randomPort = (): number => LOWEST + Math.floor(Math.random() * (ABOVE - LOWEST));

/** Whether a server can listen on `port` on `host`, or on every address when `host` is undefined. */
function listenable(port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
  });
}

/** A port nothing on this machine listens on now, on any address, picked at random below the OS's ephemeral range so
 * that parallel workers seldom pick the same one and no outgoing connection holds it. */
export async function freePort(pick: () => number = randomPort): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const port = pick();
    if ((await listenable(port, "127.0.0.1")) && (await listenable(port))) return port;
  }
  throw new Error(`no free port between ${LOWEST} and ${ABOVE - 1} after 200 tries`);
}

/** The free ports one scenario's named ports stand for. */
export class ScenarioPorts {
  private readonly ports = new Map<number, Promise<number>>();
  private readonly pick: () => Promise<number>;
  constructor(pick: () => Promise<number> = freePort) {
    this.pick = pick;
  }

  /** The free port the scenario's `named` port stands for, picked the first time a step asks. */
  real(named: number): Promise<number> {
    let p = this.ports.get(named);
    if (!p) {
      p = this.pick();
      this.ports.set(named, p);
    }
    return p;
  }

  /** `url` with a named port on this machine swapped for the port it stands for, as a scenario's "http://localhost:7400". */
  async url(url: string): Promise<string> {
    const u = new URL(url);
    if (!u.port || !/^(?:localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return url;
    const real = await this.real(Number(u.port));
    return url.replace(`${u.hostname}:${u.port}`, `${u.hostname}:${real}`);
  }
}

/** The scenario's ports, kept on its world, so each scenario gets ports of its own. */
export function scenarioPorts(world: object): ScenarioPorts {
  const w = world as { scenarioPorts?: ScenarioPorts };
  return (w.scenarioPorts ??= new ScenarioPorts());
}
