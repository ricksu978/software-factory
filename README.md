# software-factory
Cloud software factory that takes PBIs from Scrum backlogs and ships Increments with Claude agents

## Getting started

This runs the factory on your own machine, against this repo's board. It's Phase 0a of the [Phase 0 plan](docs/superpowers/plans/2026-11-05-phase-0-walking-skeleton.md). The Azure deploy comes later, through `.github/workflows/deploy.yml`.

These steps are for the board's owner, `ricksu978`. To point the factory at your own repo and board, change `config/sources.yml` and `.github/CODEOWNERS`, and use your own GitHub App's id and key.

### What you need

- Windows with PowerShell 7 (`pwsh`). The secrets script and the commands below are PowerShell.
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
aspire run
```

`aspire run` is the one command. Before any resource starts, it:

1. pulls `main` fast-forward-only, but only when you're on `main`. A pull that fails stops the start with git's own message. On any other branch it warns and runs your checkout as it is;
2. starts Docker Desktop if it isn't running, and waits up to 3 minutes for it.

A test run, with `FACTORY_FLOAT_PORTS=1` as the BDD suites start the AppHost, pulls nothing, so it never moves your checkout or waits on a git prompt.

`aspire run` also rebuilds the `factory-cell:local` image that cells run, as a resource named `cell-image` in the Aspire dashboard, so the egress proxy has an image to start from. It builds from your checkout as it is once the pull is done, with the checkout's `cell/Dockerfile`, and the worker starts only once that build has finished. A build that fails shows `cell-image` as failed, with Docker's error in its console, and the worker never starts. When your working tree is clean, the image records HEAD's commit in its `org.opencontainers.image.revision` label. With uncommitted edits it gets no label, and Floor says the image's commit is not known until the worker builds it from `main`.

Once running, the worker builds `factory-cell:local` again from `main`'s fetched commit and checks `main` on each poll. A merged change to cell-side files only (`sop/`, `policy/`, `cell/`, `src/cell/`, except `sop/default.yml` and `src/cell/sop-move.ts`, which the control plane and the worker load too) is rebuilt into the image without a restart, and the next cell runs it. A change to anything the control plane or the worker runs is not, and Floor says a restart is needed. The build never reads your checkout's working tree or local commits.

Run the same command each time you start the factory. Ctrl+C stops it. Postgres and Azurite keep their data in Aspire's volumes, so nothing is lost between runs.

### The secrets it asks for

Aspire keeps the AppHost's parameters per checkout, in that checkout's user secrets, so each new clone or worktree asks for them once. On a start with any missing, the Aspire dashboard shows **Unresolved parameters**. Select **Enter values**, fill in the form, and tick **Save to user secrets** so the next start asks nothing. The factory's resources wait until every value is in. The form hides secret values. After pasting a token copied with `Set-Clipboard`, clear it with `Set-Clipboard -Value $null`, and remove it from clipboard history (Win+V) if that's on. To change one later, run `pwsh scripts/set-local-secrets.ps1` and press Enter to keep the ones you don't change.

The factory reads the App's `.pem` from its path on every start, so keep the file where `github-app-key-path` points. A checkout set up before this took the key itself as `github-app-key`, which nothing reads now. Remove that copy of the key with `aspire secret delete Parameters:github-app-key`.

| Parameter | What to enter |
|---|---|
| `claude-oauth-token` | The token `claude setup-token` printed |
| `github-app-key-path` | The path to the App's `.pem` file. A quoted path from Explorer's "Copy as path" works. The form's fields are one line, so it takes the path, not the key |
| `github-project-token` | Your `gh` token. `gh auth token \| Set-Clipboard`, then paste |
| `cell-secret` | Any random value. `[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)) \| Set-Clipboard`, then paste |
| `github-webhook-secret` | Any random value locally, made the same way, because GitHub sends no webhooks to your machine |
| `dev-login` | Your GitHub login. Migrate gives it to the factory's local owner, so your `/approve` comments and PR reviews count as the owner's |
| `github-app-id` | `5636555` |
| `claude-token-created-at` | The date you ran `claude setup-token`, as `yyyy-mm-dd`. It drives the token-expiry banner |

### Sign in

Open the factory dashboard at http://localhost:7400. The dashboard sends you to Keycloak to sign in, at the local `factory` realm that `aspire run` starts on port 7430. Sign in as the realm's test owner, `owner`. Its password is in [`aspire-apphost/keycloak/factory-realm.json`](aspire-apphost/keycloak/factory-realm.json), under the user's credentials. Keycloak sends you back to the dashboard signed in.

Until the cut-over (#281) moves the dashboard onto port 7400, it answers on http://localhost:7403, and port 7400 still serves the old dashboard.

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
