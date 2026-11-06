# Local platform spike

Plan Task 2, run on 2026-11-06 on the owner's machine: Windows 11 on ARM64, Docker Desktop with a `linux aarch64` 29.7.2 daemon, Aspire CLI 13.6.4 and Node 26.13.0. These results come from `aspire start`, `aspire describe` and `docker run` against `factory-cell:local`.

## Results

- **AppHost.** The TypeScript AppHost carried every resource in Task 2 Step 3. `aspire start` brought up `pg`, `storage`, `migrate` and `control`, and `aspire describe migrate --format Json` reported `"exitCode": 0`.
- **Database variable.** `migrate` and `control` receive `FACTORY_DB_URI`, a `postgresql://` URI built from the database's `uriExpression()`.
- **Blob variable.** `control` receives `FACTORY_BLOB`, the Azurite connection string. Its blob endpoint is `localhost` on a port Aspire picks, 53133 on this run, and not 10000.
- **Data volume.** The probe's run count went from 1 to 2 across a stop and a start, so the Postgres volume kept its rows.
- **Installers.** Each Node app gets its own `npm install` resource. With both apps in the repo root, the two installs collided with `EBUSY`, so `control` skips its install and waits for `migrate`, whose install runs first.
- **Cell to control plane.** `curl -X POST http://host.docker.internal:7400/internal/cells/ping` from `factory-cell:local` got 204.
- **Cell to Azurite.** A PUT to a `/probe/sas` URL with its host name swapped to `host.docker.internal` got 201, so the SAS signature doesn't cover the host.
- **Bubblewrap.** It doesn't start in a local cell container. `bwrap --ro-bind / / --dev /dev true` fails with "Creating new namespace failed: Operation not permitted", under the default `docker run` and with `--security-opt seccomp=unconfined` too. The egress allowlist needs another mechanism locally, which is a pending decision.
- **Agent SDK.** Not run yet. It needs the owner's Claude token from `claude setup-token`.
- **GitHub App.** `ricksu978-software-factory`, App id 5636555, created through the manifest flow with write on contents, pull requests and issues and read on checks, commit statuses and metadata. It's installed on this repo only, as installation 179116800. Its private key and webhook secret sit in the AppHost's user secrets, never in the repo.
- **Bot assignment.** GitHub refused it. Assigning `ricksu978-software-factory[bot]` to issue #6 with an installation token holding issues write got 403 "Forbidden", and the assignees stayed empty. So Task 6's claim marker is the `factory:in-progress` label alone.
