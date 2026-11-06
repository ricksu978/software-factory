# The control plane image (plan Task 2). It serves spike/hello.ts until Task 15 swaps in src/main.ts
# and copies policy/ and config/. Azure builds it for linux/amd64 in CI (Task 19).
FROM node:26.13.0-bookworm
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY spike ./spike
# The migrate job runs src/store/migrate-cli.ts on this image, and migrate() reads db/migrations (Task 19 Step 3).
COPY src ./src
COPY db ./db
CMD ["node", "spike/hello.ts"]
