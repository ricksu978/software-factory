# Phase 0 runbook

Plan Task 18 writes this runbook. Step 6 adds how to start the factory, set its parameters, sign in, add users, rotate the keys and tokens, and use the kill switch. For now it holds only the live runs that Step 3 asks to record. "Getting started" in the README covers starting the factory locally.

## Live runs

### #105, the first live item

The factory's first PBI built locally, end to end, on 2026-11-07. All times are UTC.

- **Item.** [#105](https://github.com/ricksu978/software-factory/issues/105), "An activity log, so the owner can see what the factory is doing".
- **Run.** `3cd20dfc-5747-499a-903f-2eb2d55ac318`, on branch `factory/pbi-105-r1`.
- **PR.** [#108](https://github.com/ricksu978/software-factory/pull/108), merged at 23:30 as `1a4a355`. The item reached Done at 23:35, once CI on `main` passed.
- **Cost.** $8.38 on `claude-opus-5-5`, from the dashboard's `/phase0` report. Failed or repeated attempts cost $3.15 of it: Specify's first attempt at $0.37, the first self-review at $1.26, the first open-pr at $0.42 and the Green rerun it forced at $1.10.
- **Shadow tier.** Medium.

| Time | What happened |
|---|---|
| 08:50 | Labelled `factory` |
| 08:52 | Passed readiness, and a cell started |
| 08:55 | Scenarios posted for sign-off, 17 of them |
| 09:02 | Signed off in Run detail, and Red started |
| 09:37 | Green committed |
| 10:30 | Blocked: "Self-review didn't approve in 5 rounds" |
| 11:47 | Answered, after the fix below, and the run resumed |
| 16:23 | A GitHub DNS outage stopped the cell, and the factory re-queued it |
| 16:33 | PR opened |
| 23:35 | Done, and the factory closed the issue |

Three problems came out of the run.

- **Self-review needed the exact word.** The reviewer ended five clean rounds with `OPEN: 0`, and the engine approved only on `APPROVED`. Fixed in [#106](https://github.com/ricksu978/software-factory/pull/106).
- **A fresh clone had no dependencies.** The cell that resumed after the answer ran open-pr's `dod.md` check with nothing installed and exited 127, which cost a Green retry. PBI #95's Specify failed the same way. `commands.setup` in repo config fixes it.
- **No network meant no context.** While `api.github.com` didn't resolve, the cell API couldn't build a cell's context. The new cell exited, and the factory re-queued the item once the lease ran out. It needed nobody.
