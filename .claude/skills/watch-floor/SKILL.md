---
name: watch-floor
description: Watch the factory's Floor, approve scenario sign-offs and start a reviewer on each PR that reaches InReview, until told to stop.
disable-model-invocation: true
---

# Watch the Floor

You stand in for the owner on two decisions. You approve every scenario sign-off, and you put a reviewer on every PR that reaches InReview. Everything else the Floor shows is the owner's to act on, and you report it.

## 1. Start the watch

Run `node .claude/skills/watch-floor/watch-floor.mjs` under Monitor with the longest timeout, and re-arm it each time it expires. It signs in with the dev-login token from `aspire logs control`, polls every 30 seconds, and prints one line whenever the Floor changes:

```
status: <banners> | waiting: #319 InReview pr=#415 item=<uuid>; #283 SignOff item=<uuid> | running: #280 InProgress/red | usage pause until <time>
```

It signs in again by itself after a restart rotates the token. `factory unreachable` means the factory is stopped or restarting; keep watching. `node watch-floor.mjs --selftest` checks the parser against the markup in `src/http/views.ts` (`floorPage`); run it when the Floor's markup changes.

Done when the first digest line arrives.

## 2. Act on each line

| The line shows | You do |
|---|---|
| `#N SignOff item=<id>` under waiting | Approve it (below). |
| `#N InReview pr=#M` under waiting | Run `/review-until-merged M`, unless a reviewer you started is already on PR M. Factory PRs link no closing issue, so the scope is issue #N's body and `ISSUES` is `#N`. |
| `NeedsInput`, `FeatureChangeRequest` or a rule approval under waiting | Report it with the question from the item's Run detail. The owner answers. |
| A banner, `usage pause until`, or nothing running while items are Queued | Report what holds the factory. Drain, Prepare restart, Pause, the kill switch and the usage pause are the owner's controls. |
| One item in the same stage for over an hour | Check its cell: `docker ps --filter ancestor=factory-cell:local`, then `docker exec <cell> ps -eo etime,args`. A long BDD run is normal; report only a cell with no live work. |

**Approving a sign-off.** The token is the last `dev-login?token=` in `aspire logs control`. Then:

```
curl -b "factory_dev=<token>" -H "Origin: http://localhost:7400" -d decision=approve -d note= http://localhost:7400/items/<id>/signoff
```

Done when it answers 303 and the item's page at `/items/<id>` says `resumes at red`.

**Reading a lost claim.** `lease_expired` logged by `cell-api` is a cell handing back its claim under a Drain or Prepare restart the owner set (`endClaimForWrapUp` in `src/control/cell-api.ts`). The item resumes where it stopped. Logged by `worker`, it is the expiry sweep catching a cell that stopped renewing; check the cell as above.

## 3. When a reviewer reports

Relay its report in full. Once its PR has merged or closed, remove its worktree under `.claude/worktrees/`:

1. If its `node_modules` is a junction, remove the junction alone first with `cmd /c rmdir <worktree>\node_modules`, so removing the worktree leaves the main checkout's `node_modules` intact.
2. `git worktree remove <worktree>` once `git status --porcelain` is empty there.
3. Delete its branch once `git merge-base --is-ancestor <branch> origin/main` passes.

The watch runs until the owner stops it.
