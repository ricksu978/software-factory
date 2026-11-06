# Self-review

Review this branch's diff against its base, `git diff <base>...HEAD`, before its pull request opens. The team's rubric comes first, then the factory's own checks.

Report each rubric criterion as one JSON line, `{"index":<n>,"status":"passed"|"failed","reason":"<why>"}`, using the numbers given with the rubric. After those lines, list your findings as usual, and end with your last line.

After a finding is rebutted twice and you still hold it, end with `DEADLOCK` instead of `OPEN: <n>`.
