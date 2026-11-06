# The cell image (plan Task 2 Step 8). Locally it is built for the machine's own architecture as
# factory-cell:local and never pushed. Task 14 adds the agents, the policy defaults and a non-root user.
FROM node:26.13.0-bookworm
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl bubblewrap socat \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY spike ./spike
