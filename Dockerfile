# The control plane image (plan Task 15). Its command is src/main.ts. The migrate job runs src/store/migrate-cli.ts on
# it, which reads db/migrations, imports scripts/seed-owner.ts and seeds boards from config/sources.yml. policy/ holds
# the readiness gate's defaults and sop/ the SOP. Azure builds it for linux/amd64 in CI (Task 19). Until Task 20,
# deploy.yml gives the Azure app the spike image from spike/Dockerfile, and this one serves only the migrate job.
FROM node:26.13.0-bookworm
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY db ./db
COPY policy ./policy
COPY sop ./sop
COPY config ./config
CMD ["node", "src/main.ts"]
