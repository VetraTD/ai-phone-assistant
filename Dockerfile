# The voice server. ESM, "type": "module".
#
# Two stages so the runtime image carries no devDependencies — vitest, supertest
# and the eval harness are ~200MB of things that must never be reachable from a
# process handling calls.
#
# node:22-slim, not alpine. The Deepgram and Google SDKs pull native addons, and
# musl builds of those are the kind of problem that shows up once, in the region
# that matters, at the worst time. Debian slim costs about 40MB more and removes
# an entire class of surprise.

# ---- deps -------------------------------------------------------------------
FROM node:22-slim AS deps
WORKDIR /app

# package.json + lockfile alone, so this layer is cached until dependencies
# actually change. Copying the source first would rebuild node_modules on every
# edit, which on Cloud Build is minutes per deploy.
COPY package.json package-lock.json ./

# The `--mount=type=secret` is a WORKSTATION accommodation and nothing more.
#
# This machine runs Norton, which intercepts TLS — including inside containers.
# Without a CA bundle npm cannot verify the registry and fails with
# "Exit handler never called!", which reads as an npm bug and is not one; the
# real error is UNABLE_TO_VERIFY_LEAF_SIGNATURE, three layers down. It cost an
# hour to find, so it is written down here.
#
# Cloud Build has no Norton and passes no secret. The mount is then an empty
# file, the `if` is false, and the command is a plain `npm ci` — so this costs
# production nothing and the image contains no certificate either way.
#
# Local:  docker build --secret id=cacert,src=$HOME/gcloud-cacerts.pem .
RUN --mount=type=secret,id=cacert,target=/tmp/ca.pem     sh -c 'if [ -s /tmp/ca.pem ]; then export NODE_EXTRA_CA_CERTS=/tmp/ca.pem; fi;            npm ci --omit=dev --no-audit --no-fund'

# ---- runtime ----------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Cloud Run injects PORT and expects the container to listen on it. The default
# matches server.js's own so `docker run` without it still works.
ENV PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY services ./services
COPY capabilities ./capabilities
COPY adapters ./adapters
COPY integrations ./integrations
COPY middleware ./middleware
COPY config ./config

# The schema and its runner. Not for the voice server — nothing at runtime
# reads these — but for the Cloud Run JOB that applies migrations from inside
# the VPC, which is the only way to reach a private-IP Cloud SQL instance.
#
# One image, two entrypoints, rather than a second image: the job needs `pg`,
# the Cloud SQL connector and the migration files, and every one of those is
# already here. A separate image would duplicate node_modules to save ~200KB of
# SQL, and would then be a second thing to remember to rebuild.
#
# `scripts/` as a whole stays excluded (.dockerignore) — only this one file is
# named, so the probe harness, the eval runner and the TTS A/B tooling do not
# ship to production.
COPY scripts/migrate.js ./scripts/migrate.js
COPY database ./database

# An explicit file list rather than `COPY . .`, and it is worth the maintenance:
# it is what keeps .env, latency-runs/, docs/ and the entire test suite out of a
# production image. A .dockerignore does the same job by exclusion, which fails
# open — anything added later is included unless somebody remembers.

# Runs as an unprivileged user. The node image ships one; Cloud Run does not
# grant the container anything that needs root, so nothing is lost.
USER node

EXPOSE 3000

# Node directly, not `npm start`. npm forwards signals poorly, and on Cloud Run
# a SIGTERM that never reaches the process means every deploy drops whatever
# calls were in flight instead of draining them.
CMD ["node", "server.js"]
