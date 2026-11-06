# Build all images from one locked workspace. Build targets serially on a 2-core/8-GiB host.
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS manifests
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/content/package.json packages/content/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/im-client/package.json packages/im-client/package.json

FROM manifests AS build-deps
RUN npm ci --no-audit --no-fund

FROM build-deps AS sources
COPY . .

FROM sources AS api-build
RUN npm run build -w @zzsh/api

FROM sources AS web-build
ENV NEXT_TELEMETRY_DISABLED=1 CIRCLE_NODE_TOTAL=2 NODE_OPTIONS=--max-old-space-size=2560
RUN npm run build -w @zzsh/web

FROM web-build AS web-runtime-files
# Webpack's build cache is not required by next start and is large on the 40-GiB system disk.
RUN rm -rf /workspace/apps/web/.next/cache

FROM sources AS admin-build
RUN npm run build -w @zzsh/admin

FROM manifests AS api-runtime-deps
# The marker makes BuildKit finish the compile before starting a second npm install.
COPY --from=api-build /workspace/apps/api/dist/src/main.js /tmp/zzsh-api-build-complete
RUN npm ci --omit=dev --workspace=@zzsh/api --workspace=@zzsh/content --no-audit --no-fund

FROM manifests AS web-runtime-deps
COPY --from=web-build /workspace/apps/web/.next/BUILD_ID /tmp/zzsh-web-build-complete
RUN npm ci --omit=dev --workspace=@zzsh/web --workspace=@zzsh/ui --workspace=@zzsh/im-client --workspace=@zzsh/content --no-audit --no-fund

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS api
ENV NODE_ENV=production
WORKDIR /workspace/apps/api
COPY --from=api-runtime-deps /workspace/node_modules /workspace/node_modules
COPY --from=api-runtime-deps /workspace/apps/api /workspace/apps/api
COPY --from=sources /workspace/packages/content /workspace/packages/content
COPY --from=api-build /workspace/apps/api/dist/src /workspace/apps/api/dist/src
COPY --from=sources /workspace/apps/api/migrations /workspace/apps/api/migrations
COPY --from=sources /workspace/apps/api/assets /workspace/apps/api/assets
USER node
EXPOSE 3102
CMD ["node", "dist/src/main.js"]

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /workspace/apps/web
COPY --from=web-runtime-deps /workspace/node_modules /workspace/node_modules
COPY --from=web-runtime-deps /workspace/apps/web /workspace/apps/web
COPY --from=sources /workspace/packages /workspace/packages
COPY --from=sources /workspace/apps/web/public /workspace/apps/web/public
COPY --from=sources /workspace/apps/web/next.config.ts /workspace/apps/web/next.config.ts
COPY --from=web-runtime-files --chown=node:node /workspace/apps/web/.next /workspace/apps/web/.next
USER node
EXPOSE 3100
CMD ["node", "/workspace/node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3100"]

FROM caddy:2-alpine@sha256:70b3180738b46cd88e49b300d790ae448a0aca3f58edef0f000bb57d619a9ab3 AS proxy
COPY deploy/ecs-test/Caddyfile /etc/caddy/Caddyfile
COPY --from=admin-build /workspace/apps/admin/dist /srv/admin
