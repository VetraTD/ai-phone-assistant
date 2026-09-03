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

# ---- Who actually builds with this file ------------------------------------
#
# CLOUD BUILD does. Railway does NOT, and that is deliberate: `railway.json`
# pins Railway to NIXPACKS.
#
# Railway auto-detects its builder and prefers a Dockerfile when it finds one.
# This file arrived on feat/s2s-frontend, so the first staging deploy from that
# branch switched Railway off Nixpacks -- which had built the app fine for
# months -- and onto this, where it failed in five seconds. The `--mount=type=secret`
# below is BuildKit-only; a builder without BuildKit cannot parse it at all.
#
# Rather than debug someone else's builder to reach a phone call, Railway is
# pinned back to the path that already worked. If this image is ever wanted on
# Railway, the portable change is to drop the secret mount for a plain build
# ARG -- a CA certificate is not a secret, so the mount was only ever buying
# build-context hygiene.

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
# Same job, different entrypoint: seeds one synthetic business into a
# STAGING database so a test call reaches the receptionist instead of the
# unrouted-voicemail path. Safe to ship — it refuses unless the database and
# instance names both say staging.
COPY scripts/seed-staging.js ./scripts/seed-staging.js
# Read-only. Answers questions about what the REAL database allows, which the
# local dev container cannot be trusted to represent — it is more permissive.
COPY scripts/db-inspect.js ./scripts/db-inspect.js
# Lane C's two verification entrypoints. Same job, same reason as the three
# above: staging's Cloud SQL is private-IP only, so a check that has to run
# against the real database has to travel in the image.
#
# These were written, committed, sabotage-verified and documented in a runbook
# while being absent from this file — which would have surfaced as
# `Cannot find module` in front of the owner during a scheduled verification,
# because nothing else in the repo imports them and no test could have noticed.
# The build now imports both (cloudbuild.yaml, smoke-verifiers) so the next
# omission fails a build instead.
COPY scripts/c8-rls-proof.js ./scripts/c8-rls-proof.js
COPY scripts/c7-restore-parity.js ./scripts/c7-restore-parity.js

# Lane U. One-tenant CONFIG import — the D3 rehearsal, and the tool D3 itself
# needs. Config only: it refuses a payload naming any PHI table.
COPY scripts/import-tenant.js ./scripts/import-tenant.js
COPY scripts/attach-tenant-user.js ./scripts/attach-tenant-user.js
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
