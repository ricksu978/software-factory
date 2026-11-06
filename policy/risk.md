# Risk tiers: factory default

The risk classifier reads this whole file to decide what each tier means in a repo with no `.factory/risk.md`. It's guidance, and a repo's file replaces it whole. The examples are the spec's Risk tiers table. Path rules run first, and nothing here can lower them.

- **Low.** Docs, copy, internal-only features, additive changes behind a flag.
- **Medium.** Ordinary product changes, and changes to sensitive areas such as caching, the auto-updater, or system prompts.
- **High.** The highest-risk code, plus a small set of paths that always need two people.
