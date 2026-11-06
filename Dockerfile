# The control plane image (plan Task 15). It runs src/main.ts, and the migrate job runs src/store/migrate-cli.ts on
# it, which reads db/migrations and imports scripts/seed-owner.ts. policy/ holds the readiness gate's defaults and
# sop/ the SOP. Azure builds it for linux/amd64 in CI (Task 19).
# config/ doesn't exist until config/sources.yml lands in PBI 18 (plan Task 18 Step 1), which adds `COPY config ./config`.
FROM node:26.13.0-bookworm
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY db ./db
COPY policy ./policy
COPY sop ./sop
CMD ["node", "src/main.ts"]
