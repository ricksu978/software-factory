# Phase 0 runbook

Plan Task 18 writes this runbook. Step 6 adds how to start the factory, set its parameters, sign in, add users, rotate the keys and tokens, and use the kill switch. For now it holds only the live runs that Step 3 asks to record. "Getting started" in the README covers starting the factory locally.

## Live runs

### #105, the first live item

The first PBI the factory took from its board and built itself, end to end, on 2026-11-07. All times are UTC.

- **Item.** [#105](https://github.com/ricksu978/software-factory/issues/105), "An activity log, so the owner can see what the factory is doing".
- **Run.** `3cd20dfc-5747-499a-903f-2eb2d55ac318`, on branch `factory/pbi-105-r1`. The id is the folder that holds the run's transcripts, `transcripts/<runId>/` (plan Task 12, `POST /upload-url`).
- **PR.** [#108](https://github.com/ricksu978/software-factory/pull/108), merged at 23:30 as `1a4a355`. The item reached Done at 23:35, once CI on `main` passed.
- **Cost.** $8.38 on `claude-opus-5-5`, from the dashboard's `/phase0` report. $3.64 of it went on attempts that failed or had to run again: Specify's first ($0.37), the first self-review ($1.26), the first open-pr ($0.42), and the Green rerun ($1.10) and second self-review ($0.49) that open-pr's failure forced.
- **Shadow tier.** Medium.

| Time | What happened |
|---|---|
| 08:50 | Labelled `factory` |
| 08:52 | Passed readiness, and a cell started |
| 08:55 | Scenarios posted for sign-off: 14 written, 16 run with one outline's three examples |
| 09:02 | Signed off in Run detail, and Red started |
| 09:37 | Green committed |
| 10:30 | Blocked: "Self-review didn't approve in 5 rounds" |
| 11:47 | Answered, after the first fix below, and the run resumed |
| 16:23 | While this machine couldn't resolve `api.github.com`, the item was claimed again and its new cell exited without its context |
| 16:30 | Another cell resumed the run, the fifth since 08:52 |
| 16:33 | PR opened |
| 23:35 | Done, and the board's Auto-close workflow closed the issue a second later |

Four problems came out of the run.

- **Self-review needed the exact word.** The reviewer ended five clean rounds with `OPEN: 0`, and the engine approved only on `APPROVED`. Fixed in [#106](https://github.com/ricksu978/software-factory/pull/106).
- **A fresh clone had no dependencies.** The cell that resumed after the answer ran open-pr's `dod.md` check with nothing installed and exited 127, which forced the Green rerun and second self-review above. [#95](https://github.com/ricksu978/software-factory/issues/95)'s Specify failed the same way. An optional `commands.setup` in repo config, run before any stage, is in review on branch `fix/commands-setup`.
- **No network meant no context.** The cell API builds a cell's context from GitHub, so a cell started while `api.github.com` didn't resolve exited at once. The factory claimed the item again once GitHub answered, and needed nobody.
- **The board closed the issue itself.** The Project's "Auto-close issue" workflow was still on, so it closed #105 the moment the factory set its status to Done. GitHub records the owner, `ricksu978`, as the closer, not the factory's App. Plan Task 18 Step 2 has the factory own the board, and the owner turned the workflow off on 2026-11-08.
