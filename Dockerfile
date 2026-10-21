# syntax=docker/dockerfile:1.7
# Koyeb free instance: 512 MB RAM, so the V8 heap is capped at 384 MB (PRD-API §3).

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm build

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:24-slim AS runtime
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION \
    PORT=8000 \
    NODE_OPTIONS=--max-old-space-size=384
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 8000
CMD ["node", "dist/main.js"]
