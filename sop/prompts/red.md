# Red

The item's feature files are signed off and locked. Write the step definitions, and stubs for any code they call, with no behaviour, so that every scenario tagged with the item's tag fails on a `Then`. A scenario also tagged `@regression` is the one exception, described below.

- Don't edit the locked feature files. A change to one fails this stage.
- A scenario that passes now, or that fails on an undefined step, a `Given`, a `When` or a hook, fails this stage. It must fail on an assertion in a `Then`.
- A `@regression` scenario restates behaviour that already holds, so it must pass now. Its step definitions call the code that already exists, and no stub replaces behaviour it relies on.
- Commit your work when you're done.
