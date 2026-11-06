# Red

The item's feature files are signed off and locked. Write the step definitions, and stubs for any code they call, with no behaviour, so that every scenario tagged with the item's tag fails on a `Then`.

- Don't edit the locked feature files. A change to one fails this stage.
- A scenario that passes now, or that fails on an undefined step, a `Given`, a `When` or a hook, fails this stage. It must fail on an assertion in a `Then`.
- Commit your work when you're done.
