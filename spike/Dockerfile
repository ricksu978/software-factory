# The spike control image (plan Task 19). deploy.yml pushes it as control-spike:<sha> and gives it to the app until
# Task 20. It copies src/ because spike/hello.ts serves the model gateway from src/control/model-gateway.ts.
FROM node:26.13.0-bookworm
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY spike ./spike
COPY src ./src
CMD ["node", "spike/hello.ts"]
