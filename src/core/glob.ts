import { matchesGlob } from "node:path";

// matchesGlob never lets `*` match a leading dot and takes no `dot` option, so `**` alone would skip `.github/` and
// `.factory/`. Swapping each segment's leading dot for NUL, which no git path holds, in both glob and path closes the
// gap, so a glob covers dotfiles the way gitignore and CODEOWNERS do.
const undot = (s: string) => s.replace(/(^|\/)\./g, "$1\0");

/** True when a repo path matches a glob, dotfiles and dot directories included. */
export function matchesPath(path: string, glob: string): boolean {
  return matchesGlob(undot(path), undot(glob));
}
