// Types for prose-lint.mjs, which stays plain JavaScript so its editor-hook copy runs without a build.
/** A finding: the 1-based line, then the message. */
export type Finding = [number, string];
export const ONE_SENTENCE_FILES: string[];
export function lint(text: string, ext: string, path?: string): Finding[];
export function sentenceBreaks(text: string): number[];
export function proseView(text: string, html: boolean): string;
export function oneSentenceFindings(text: string, html: boolean): Finding[];
