# software-factory
Cloud software factory that takes PBIs from Scrum backlogs and ships Increments with Claude agents

## Getting started

This runs the factory on your own machine, against this repo's board. It's Phase 0a of the [Phase 0 plan](docs/superpowers/plans/2026-11-05-phase-0-walking-skeleton.md). The Azure deploy comes later, through `.github/workflows/deploy.yml`.

These steps are for the board's owner, `ricksu978`. To point the factory at your own repo and board, change `config/sources.yml` and `.github/CODEOWNERS`, and use your own GitHub App's id and key.

### What you need

- Windows with PowerShell 7 (`pwsh`). The start script is PowerShell.
- Node 26.13.0 or later (`package.json`).
- Docker Desktop. Cells, Postgres and the Azurite storage emulator all run in it.
- The [Aspire CLI](https://aspire.dev), version 13.6.4 (`aspire.config.json`).
- The GitHub CLI, signed in as the board's owner with the `project` scope: `gh auth login -s project`, or `gh auth refresh -s project` if you're already signed in. The default login can't reach a Project board.
- The factory GitHub App's private key, as a `.pem` file.
- A Claude subscription token from `claude setup-token`.

### Run it

```powershell
git clone https://github.com/ricksu978/software-factory.git
cd software-factory
npm run factory
```

`npm run factory` runs `scripts/factory.ps1`, which:

1. fast-forwards `main`, but only when you're on `main`;
2. starts Docker Desktop if it isn't running, and waits up to 3 minutes for it;
3. asks for any AppHost secret this checkout doesn't have yet;
4. rebuilds the `factory-cell:local` image that cells run, so the egress proxy has an image to start from. When your working tree is clean, the image records HEAD's commit in its `org.opencontainers.image.revision` label. With uncommitted edits it gets no label, and Floor says the image's commit is not known until the worker builds it from `main`;
5. runs `aspire run`.

Once running, the worker builds `factory-cell:local` again from `main`'s fetched commit and checks `main` on each poll. A merged change to cell-side files only (`sop/`, `policy/`, `cell/`, `src/cell/`, except `sop/default.yml` and `src/cell/sop-move.ts`, which the control plane and the worker load too) is rebuilt into the image without a restart, and the next cell runs it. A change to anything the control plane or the worker runs is not, and Floor says a restart is needed. The build never reads your checkout's working tree or local commits.

Run the same command each time you start the factory. Ctrl+C stops it. Postgres and Azurite keep their data in Aspire's volumes, so nothing is lost between runs.

### The secrets it asks for

Aspire keeps the AppHost's secrets per checkout, so each new clone or worktree asks for them once. Secret values are typed hidden and never echoed. After pasting a token copied with `Set-Clipboard`, clear it with `Set-Clipboard -Value $null`, and remove it from clipboard history (Win+V) if that's on. To change one later, run `pwsh scripts/set-local-secrets.ps1` and press Enter to keep the ones you don't change.

| Prompt | What to enter |
|---|---|
| `claude-oauth-token` | The token `claude setup-token` printed |
| `github-app-key` | The path to the App's `.pem` file. A quoted path from Explorer's "Copy as path" works |
| `github-project-token` | Your `gh` token. `gh auth token \| Set-Clipboard`, then paste |
| `cell-secret` | Any random value. `[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)) \| Set-Clipboard`, then paste |
| `github-webhook-secret` | Any random value locally, made the same way, because GitHub sends no webhooks to your machine |
| `dev-login` | Your GitHub login. The local dashboard signs you in as this user, and it becomes the owner |
| `github-app-id` | `5636555` |
| `claude-token-created-at` | The date you ran `claude setup-token`, as `yyyy-mm-dd`. It drives the token-expiry banner |

### Sign in

`aspire run` prints the Aspire dashboard's URL. Open it, then the `control` resource's console, which shows the factory dashboard's sign-in link for this start. Each start makes a new link, and a sign-in from an earlier start is refused until you open this start's link.

Floor shows what the factory is doing, with Pause, Drain, Resume and the kill switch. Run detail shows one run, with Hold, Stop the run and Re-queue.

### Give it work

The factory polls the board every 5 minutes and takes open issues labelled `factory`, one at a time.

1. Write an issue, put it on the board, and label it `factory`. To pass the readiness check, it needs:
   - an `## Acceptance criteria` heading with each criterion as a bullet line (`-` or `- [ ]`) under it, since prose there counts as no criteria;
   - everything [`.factory/dor.md`](.factory/dor.md) asks for, such as naming the plan task or spec section it implements;
   - no open blocked-by dependency.

   A cell can't run `@local` scenarios, so leave out anything that needs your own machine.
2. If the item isn't ready, the factory comments with each check it failed. Otherwise it posts the scenarios it plans to build. Sign them off in the dashboard's Run detail. Comment commands such as `/approve` need webhooks, which only arrive once it runs in Azure.
3. A cell builds the item and opens a PR, with you requested as reviewer (`.github/CODEOWNERS`).
4. You review and merge it. Once CI on `main` is green for the merge, the item moves to Done and the issue closes.

`config/sources.yml` names the board and maps each factory state to its Status column.
