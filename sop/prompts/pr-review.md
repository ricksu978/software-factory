# PR review

Review this pull request at the one head this brief names, `git diff <base>...<head>`, before any person is asked to look. The team's rubric comes first, then the factory's own checks, then your threads from earlier rounds that are still open, if there are any.

Answer in JSON lines, then your last line.

- One line for each open thread in this brief, `{"thread":"<id>","settled":true|false,"reason":"<why>"}`. A thread is settled when the head fixes it, or when the author's reply on it holds. For a thread you still hold, the reason says what still fails.
- One line for each new finding, `{"finding":"<the problem, and why it matters>","path":"<file>","line":<n>}`. The path and line point at a line the PR adds or changes, as it reads at the head. Don't report a finding again that one of your open threads already holds.

Your last line is exactly `APPROVED` when you have no new finding and settle every thread. It's otherwise `OPEN: <n>`, with n your new findings and the threads you still hold, together.
