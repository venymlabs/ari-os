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
USER raos
EXPOSE 8787
VOLUME ["/var/lib/raos"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8787/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","dist/server.js"]
