# PR review: factory default

The self-reviewer and the PR reviewer judge a pull request against each line below when the repo has no `.factory/pr-review.md` of its own. A repo's file replaces it whole. The engine's BDD checks run as well, and no line here can weaken them.

- [ ] The change is correct, and it breaks no behaviour that worked before.
- [ ] The change adds no security weakness, such as an injection, a leaked secret or a missing permission check.
- [ ] The change does what the linked item asks for, and nothing the item leaves out.
- [ ] The change follows the repo's own `AGENTS.md`, `CLAUDE.md` or `CONTRIBUTING.md`, when the repo has one.
