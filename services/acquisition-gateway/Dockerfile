FROM node:22-alpine AS build
# better-sqlite3 has no prebuilt binary for linux-musl (Alpine); these build the native
# addon from source via node-gyp instead of falling back to a different DB engine.
RUN apk add --no-cache python3 make g++
RUN corepack enable pnpm
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY services/acquisition-gateway ./services/acquisition-gateway
# --ignore-scripts: the repo root's own postinstall (Next.js pdfjs/unrar vendor sync)
# is irrelevant here and its source deps aren't part of this filtered install; rebuild
# only the native addon this service actually needs (approved via root package.json's
# pnpm.onlyBuiltDependencies).
RUN pnpm --filter @abs/acquisition-gateway... install --frozen-lockfile --ignore-scripts \
  && pnpm rebuild better-sqlite3 \
  && pnpm --filter @abs/acquisition-contract build \
  && pnpm --filter @abs/acquisition-gateway build

FROM node:22-alpine
# pnpm's workspace node_modules are symlink-based into the repo-root virtual store
# (node_modules/.pnpm); `pnpm deploy` (the usual fix) re-resolves the whole workspace
# including the root app's git-hosted dependency, which needs `git` and network access
# this build stage doesn't have. Instead, preserve the same relative directory layout
# from the build stage so the service's symlinks keep resolving.
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/services/acquisition-gateway/dist ./services/acquisition-gateway/dist
COPY --from=build /repo/services/acquisition-gateway/node_modules ./services/acquisition-gateway/node_modules
COPY --from=build /repo/services/acquisition-gateway/package.json ./services/acquisition-gateway/package.json
# The workspace symlink node_modules/@abs/acquisition-contract -> ../../packages/acquisition-contract
# needs its target present too: built dist/ + package.json, AND node_modules -- the
# contract package has a real runtime dependency (zod, for its .parse() calls) now that
# t300 gave it a real build step, so "dist + package.json only" (t200's assumption, back
# when the contract was type-only and zod was erased at compile) silently broke at runtime
# with `Cannot find module 'zod'` -- reproduced via an actual `docker run`, not just build.
COPY --from=build /repo/packages/acquisition-contract/dist ./packages/acquisition-contract/dist
COPY --from=build /repo/packages/acquisition-contract/package.json ./packages/acquisition-contract/package.json
COPY --from=build /repo/packages/acquisition-contract/node_modules ./packages/acquisition-contract/node_modules
WORKDIR /repo/services/acquisition-gateway
USER node
CMD ["node", "dist/main.js"]
