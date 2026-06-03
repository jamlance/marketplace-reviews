# Multi-stage build for the Loyalty embedded app.
# Build context is the repo root (Coolify base_directory = /).

# --------------------------------------------------------------- builder
FROM node:20-alpine AS builder
WORKDIR /work
RUN apk add --no-cache git python3 make g++
RUN npm install -g pnpm@9

COPY package.json pnpm-workspace.yaml ./
COPY packages/core ./packages/core
COPY apps/reviews ./apps/reviews

RUN pnpm install --no-frozen-lockfile

WORKDIR /work/apps/reviews
RUN pnpm exec vite build

# --------------------------------------------------------------- runtime
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache git

COPY --from=builder /work/package.json /work/pnpm-workspace.yaml ./
COPY --from=builder /work/node_modules ./node_modules
COPY --from=builder /work/packages ./packages
COPY --from=builder /work/apps/reviews/package.json ./apps/reviews/package.json
COPY --from=builder /work/apps/reviews/node_modules ./apps/reviews/node_modules
COPY --from=builder /work/apps/reviews/dist ./apps/reviews/dist

COPY apps/reviews/server.js ./apps/reviews/server.js

EXPOSE 3000
ENV PORT=3000 HOST=0.0.0.0
WORKDIR /app/apps/reviews
CMD ["node", "server.js"]
