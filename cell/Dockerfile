# The cell image (plan Task 2 Step 8, Task 14 Step 6). Locally it is built for the machine's own architecture as
# factory-cell:local and never pushed. It runs as the non-root factory user, with the factory's own agents.
FROM node:26.13.0-bookworm
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl bubblewrap socat \
  && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/bash factory
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY spike ./spike
COPY src ./src
COPY sop ./sop
COPY policy ./policy
COPY --chown=factory:factory cell/claude/agents /home/factory/.claude/agents
ENV FACTORY_POLICY_DIR=/app/policy
USER factory
CMD ["node", "src/cell/main.ts"]
