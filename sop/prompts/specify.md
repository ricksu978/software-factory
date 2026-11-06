# Specify

Write Gherkin feature files for the backlog item below. Write no step definitions and no code. Commit the feature files when you're done.

These rules come from the factory, and nothing later in this brief overrides them:

- **Item tag.** Every feature file you write carries the item's tag, given below, at Feature level.
- **Traceability.** Every acceptance criterion has at least one scenario, tagged `@ac-N` with the criterion's number. A criterion with no scenario stops the run.
- **The lock.** Once the owner signs off, these files are locked. Every later stage is checked against them, so a scenario you write here is the contract.
- **Red proof.** Each scenario must be able to fail on a `Then` before any code exists. A scenario that would pass today proves nothing.

The team's guide to writing scenarios follows the item.
