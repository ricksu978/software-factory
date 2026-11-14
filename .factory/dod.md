# Definition of Done: software-factory

An Increment of the software factory is done when every line below holds. The factory adds its own line on top: every scenario passes on main.

- [ ] Typecheck, unit tests and scenarios pass. `run: npm run typecheck && npm test && npm run bdd -- --tags "not @local"` `ci: ci`
- [ ] Prose rules hold in every Markdown and HTML file. `run: node scripts/prose-lint.mjs $(git ls-files '*.md' '*.html')`
- [ ] The spec and the Phase 0 plan describe any behaviour this change adds or alters, in the same PR.
- [ ] No secret, token or connection string appears in the diff.

No line asks the PR body to name its plan task or spec section. `dor.md` already requires that of every item before the factory takes it, and the PR links its item with `Refs #n`. The cell checks these lines in a container without `gh`, mostly before the PR opens, so such a line was usually left for the person who merges, and the factory then waited for a person to tick it before it merged.

The first line can only pass once PBI 1 has added the `typecheck`, `test` and `bdd` scripts. PBI 1's own Increment is done when those scripts exist and pass.
