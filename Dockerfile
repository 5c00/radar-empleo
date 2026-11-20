# syntax=docker/dockerfile:1

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PYTHON_BIN=python3
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --break-system-packages --no-cache-dir python-jobspy
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY jobspy ./jobspy
RUN mkdir -p /data \
 && chown -R node:node /data /app
USER node
VOLUME /data
CMD ["sh", "-c", "echo 'radar-empleo idle; run via scheduled task' && tail -f /dev/null"]
