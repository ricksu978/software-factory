# Definition of Ready: factory default

The readiness check uses this file when a repo has no `.factory/dor.md` of its own. A repo's file replaces it whole. Each `- [ ]` line is one criterion, and the readiness model judges every item against each one.

- [ ] Every acceptance criterion can become a Given/When/Then scenario that a test can check.
- [ ] The scope is clear enough to build without guessing.
- [ ] The item fits one Sprint.
