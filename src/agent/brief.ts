// PBI 326: the line a call's transcript starts with, holding the brief the agent was given, so the transcript page can
// show it before the call's turns. React-free and SDK-free, so the SPA's transcript reader imports it too.

/** The `type` of a transcript's brief line, one the SDK's own messages never take. */
export const BRIEF_TYPE = "factory_brief";

/** The brief line a call's transcript starts with, without its newline. */
export const briefLine = (prompt: string) => JSON.stringify({ type: BRIEF_TYPE, prompt });
