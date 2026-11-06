/**
 * `data` in a Markdown code fence longer than any backtick run inside it, so nothing in the data can close the fence
 * and pass as prompt. For any untrusted text a model must read as data: an item's body, an agent's diff.
 */
export function fenced(data: string, lang = ""): string {
  const fence = "`".repeat(Math.max(3, ...[...data.matchAll(/`+/g)].map((x) => x[0].length + 1)));
  return `${fence}${lang}\n${data}\n${fence}`;
}
