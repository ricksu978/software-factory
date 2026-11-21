// PBI 364: a stage that runs after sign-off may ask to change a locked feature file. Pure: no I/O.
//
// The stage's agent asks in its report, one line per file it wants to change, in the form
//   FEATURE CHANGE: <path>: <reason>
// The factory still restores the locked files and pushes the rest of the stage's work, then moves the item from
// InProgress to FeatureChangeRequest with the request: each file named, with its text at the lock commit (`before`),
// the version the agent proposed (`after`), and the agent's reason.

/** One locked feature file a feature change request asks to change. */
export type FeatureChangeFile = { path: string; reason: string; before: string; after: string };
