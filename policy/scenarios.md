# Writing scenarios: factory default

Specify reads this whole file when it writes feature files for a repo with no `.factory/scenarios.md`. It's guidance, so nothing scores it line by line. A repo's file replaces it whole.

- Write each scenario in business language the Product Owner can read. Selectors, SQL and class names belong in the step definitions.
- Give each business rule its own `Rule`.
- Under each rule, cover the happy path, the edge cases and the failures.
- Tag a scenario `@regression` only when its criterion asks that behaviour which already exists keeps working, such as "every existing test still passes". Red then needs it to pass, not fail. Every other scenario must fail at Red.
