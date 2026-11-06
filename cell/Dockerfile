# The cell image (plan Task 2 Step 8). Locally it is built for the machine's own architecture as
# factory-cell:local and never pushed. Task 14 adds the agents and the policy defaults.
FROM node:26.13.0-bookworm
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl bubblewrap socat ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Postgres 17 server binaries, so every test can start its own server in the cell (PBI 22, plan Global Constraints).
# The repository setup follows https://www.postgresql.org/download/linux/debian/ with the bookworm suite and
# no Architectures line, so apt takes the machine's own. postgresql-common goes in first so the default `main`
# cluster can be turned off before the server package's install would create it.
RUN install -d /usr/share/postgresql-common/pgdg \
  && curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc --fail https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && printf 'Types: deb\nURIs: https://apt.postgresql.org/pub/repos/apt\nSuites: bookworm-pgdg\nComponents: main\nSigned-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc\n' > /etc/apt/sources.list.d/pgdg.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-common \
  && sed -i 's/^#\?\s*create_main_cluster\s*=.*/create_main_cluster = false/' /etc/postgresql-common/createcluster.conf \
  && apt-get install -y --no-install-recommends postgresql-17 \
  && rm -rf /var/lib/apt/lists/*
ENV FACTORY_PG_BIN=/usr/lib/postgresql/17/bin

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY spike ./spike

# initdb refuses to run as root, so the cell runs as `factory`, as plan Task 14 Step 6 has it.
RUN useradd -m factory
USER factory
