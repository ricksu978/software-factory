# Self-review

Review this branch's diff against its base, `git diff <base>...HEAD`, before its pull request opens. The team's rubric comes first, then the factory's own checks.

Report each rubric criterion as one JSON line, `{"index":<n>,"status":"passed"|"failed","reason":"<why>"}`, using the numbers given with the rubric. After those lines, list your findings as usual, and end with your last line.

After a finding is rebutted twice and you still hold it, end with `DEADLOCK` instead of `OPEN: <n>`.

The item's feature files are locked once the owner signs them off. No finding you hold open may ask for a change to a scenario. A scenario you think is wrong goes on a `SCENARIO NOTE:` line instead, and the factory carries it into the PR body for the person who merges.
