// The fixed port check (PBI 390 AC-3): finds each place in the step definitions that starts a server on, or connects
// to, a port written into the code, so two workers running scenarios at once never collide on one.

/** One place in a step definition that uses a port fixed in its code. `file` is relative to the root, with `/`. */
export type FixedPort = { file: string; line: number; port: number; use: "listen" | "connect" };

/** Every place under `<root>/features/steps` that starts a server on, or connects to, a fixed port. */
export function findFixedPorts(_root: string): FixedPort[] {
  throw new Error("the fixed port check isn't built yet (PBI 390)");
}
