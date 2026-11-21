// Ports for the BDD suite's steps (PBI 390 AC-3). Scenarios run in parallel workers on one machine, so no step starts
// a server on, or connects to, a port fixed in its code. A step that starts a server takes a free port. A scenario may
// still name the ports it's about ("the cell API service starts on port 7401"): each port a scenario names stands for
// a free port of its own, the same one for the whole scenario, so every step that starts a server on it or connects
// to it reaches the same server, and never another worker's or a program that really holds the named port.
import { createServer } from "node:net";

/** A port nothing on this machine listens on now, as the OS hands one out. */
export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve, reject) => {
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (s.address() as { port: number }).port;
  await new Promise((resolve) => s.close(resolve));
  return port;
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
