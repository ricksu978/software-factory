# software-factory
Cloud software factory that takes PBIs from Scrum backlogs and ships Increments with Claude agents

## Getting started

This runs the factory on your own machine, against this repo's board. It's Phase 0a of the [Phase 0 plan](docs/superpowers/plans/2026-11-05-phase-0-walking-skeleton.md). The Azure deploy comes later, through `.github/workflows/deploy.yml`.

### What you need

- Windows with PowerShell 7 (`pwsh`). The start script is PowerShell.
- Node 26.13.0 or later (`package.json`).
- Docker Desktop. Cells, Postgres and the Azurite storage emulator all run in it.
- The [Aspire CLI](https://aspire.dev), version 13.6.4 (`aspire.config.json`).
- The GitHub CLI, signed in as the board's owner (`gh auth login`).
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
4. rebuilds the `factory-cell:local` image that cells run;
5. runs `aspire run`.

Run the same command each time you start the factory. Ctrl+C stops it. Postgres and Azurite keep their data in Aspire's volumes, so nothing is lost between runs.

### The secrets it asks for

Aspire keeps the AppHost's secrets per checkout, so each new clone or worktree asks for them once. Secret values are typed hidden and never echoed. To change one later, run `pwsh scripts/set-local-secrets.ps1` and press Enter to keep the ones you don't change.

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

`aspire run` prints the Aspire dashboard's URL. Open it, then the `control` resource's console, which shows the factory dashboard's sign-in link for this start. Each start makes a new link, and a sign-in from an earlier start is refused until you open it.

The dashboard's Floor shows what the factory is doing, Run detail shows each run, and the pause, drain, hold, re-queue and kill switch controls work from there.

### Give it work

The factory polls the board every 5 minutes and takes open issues labelled `factory`, one at a time.

1. Write an issue with an `## Acceptance criteria` section, put it on the board, and label it `factory`. A cell can't run `@local` scenarios, so leave out anything that needs your own machine.
2. The factory posts a readiness comment, then the scenarios it plans to build. Sign them off in the dashboard's Run detail. Comment commands such as `/approve` need webhooks, which only arrive once it runs in Azure.
3. A cell builds the item and opens a PR, with you requested as reviewer (`.github/CODEOWNERS`).
4. You review and merge it. Once CI on `main` is green for the merge, the item moves to Done and the issue closes.

`config/sources.yml` names the board and maps each factory state to its Status column.
