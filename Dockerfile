# syntax=docker/dockerfile:1.7

# ---- Build stage ----
FROM node:26-alpine AS build
WORKDIR /app

COPY package*.json tsconfig.json ./
# --ignore-scripts: no dependency here needs lifecycle scripts, and disabling
# them removes the postinstall supply-chain attack vector.
RUN npm ci --ignore-scripts

COPY src ./src
RUN npm run build

# ---- Runtime stage ----
FROM node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Install production deps only, lifecycle scripts disabled
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist

# Drop root
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
