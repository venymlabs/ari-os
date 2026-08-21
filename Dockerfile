# The operator console. Built in its own stage against its own lockfile: `web/`
# is a separate npm package with a separate dependency budget and a separate
# audit, and none of its 200-odd build-time devDependencies may reach runtime.
# Only `/web/dist` is copied forward — the image ships the artefact, never the
# source.
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
# The daemon serves this bundle from its own origin, so the API base is
# RELATIVE. `web/.env.production` sets the same value; this ARG exists so an
# operator behind a path prefix can override it, and because a silently
# fixture-mode console is the worst possible failure of this build.
ARG VITE_ARI_API=/api
ENV VITE_ARI_API=${VITE_ARI_API}
RUN npm run build

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
RUN groupadd --system raos && useradd --system --gid raos --home /var/lib/raos raos && mkdir -p /var/lib/raos && chown raos:raos /var/lib/raos
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/var/lib/raos HOST=0.0.0.0 PORT=8787
COPY --from=build --chown=raos:raos /app/package*.json ./
COPY --from=build --chown=raos:raos /app/node_modules ./node_modules
COPY --from=build --chown=raos:raos /app/dist ./dist
# `src/control/index.ts` resolves the console relative to its own module, so
# `dist/control/` + `../../web/dist` lands exactly here.
COPY --from=web --chown=raos:raos /web/dist ./web/dist
USER raos
EXPOSE 8787
VOLUME ["/var/lib/raos"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8787/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","dist/server.js"]
