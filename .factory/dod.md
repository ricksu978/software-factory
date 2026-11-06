# Definition of Done: software-factory

An Increment of the software factory is done when every line below holds. The factory adds its own line on top: every scenario passes on main.

- [ ] Typecheck, unit tests and scenarios pass. `run: npm run typecheck && FACTORY_DB_TESTS=skip npm test && npm run bdd -- --tags "not @db and not @local"`
- [ ] Prose rules hold in every Markdown and HTML file. `run: node scripts/prose-lint.mjs $(git ls-files '*.md' '*.html')`
- [ ] The spec and the Phase 0 plan describe any behaviour this change adds or alters, in the same PR.
- [ ] No secret, token or connection string appears in the diff.
- [ ] The PR body names the plan task or spec section the change implements.

The first line can only pass once PBI 1 has added the `typecheck`, `test` and `bdd` scripts. PBI 1's own Increment is done when those scripts exist and pass.
