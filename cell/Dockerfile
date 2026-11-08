# The cell image (plan Task 2 Step 8, Task 14 Step 6). Locally it is built for the machine's own architecture as
# factory-cell:local and never pushed. It runs as the non-root factory user, with the factory's own agents.
FROM node:26.13.0-bookworm
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl bubblewrap socat ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Postgres 17 server binaries, so every test can start its own server in the cell (PBI 22, plan Global Constraints).
# The repository setup follows https://www.postgresql.org/download/linux/debian/ with the bookworm suite and
# no Architectures line, so apt takes the machine's own. postgresql-common goes in first so the default `main`
# cluster can be turned off before the server package's install would create it. initdb refuses to run as root,
# which the factory user below never is.
RUN install -d /usr/share/postgresql-common/pgdg \
  && curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc --fail https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && printf 'Types: deb\nURIs: https://apt.postgresql.org/pub/repos/apt\nSuites: bookworm-pgdg\nComponents: main\nSigned-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc\n' > /etc/apt/sources.list.d/pgdg.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-common \
  && sed -i 's/^#\?\s*create_main_cluster\s*=.*/create_main_cluster = false/' /etc/postgresql-common/createcluster.conf \
  && apt-get install -y --no-install-recommends postgresql-17 \
  && rm -rf /var/lib/apt/lists/*
ENV FACTORY_PG_BIN=/usr/lib/postgresql/17/bin

RUN useradd --create-home --shell /bin/bash factory
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY spike ./spike
COPY src ./src
COPY sop ./sop
COPY policy ./policy
# src/agent/run.ts reads the factory's agents from /app/cell and passes them in the run's options, so a checkout's
# .claude/agents/ file of the same name can't replace them (PBI 96). The user copy serves any other Claude Code run.
COPY cell/claude/agents ./cell/claude/agents
COPY --chown=factory:factory cell/claude/agents /home/factory/.claude/agents
ENV FACTORY_POLICY_DIR=/app/policy
USER factory
CMD ["node", "src/cell/main.ts"]
