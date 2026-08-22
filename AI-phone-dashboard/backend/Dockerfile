# The dashboard backend. CommonJS, "type": "commonjs".
#
# A separate image from the voice server's, not a shared one with two entry
# points, and that is deliberate: they scale on completely different curves. The
# voice server runs min-instances=1 with CPU always allocated because a cold
# start inside a phone call is unrecoverable; this one scales to zero between
# logins. One image would force the expensive answer on both.
#
# Same base and same two-stage shape as the root Dockerfile — see its comments
# for why node:22-slim and why devDependencies stay out of the runtime.

# ---- deps -------------------------------------------------------------------
FROM node:22-slim AS deps
WORKDIR /app

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
# Matches src/server.js's own default, so `docker run` with no PORT works.
ENV PORT=3001

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# src/ is copied wholesale because the app is genuinely all of it — but that
# sweeps in src/__tests__, which is 90 tests and their fixtures. .dockerignore
# already excludes it from the context; this is the belt to that pair of braces,
# because an exclusion list fails open and a production image containing the
# test suite is the kind of thing nobody notices until an audit asks.
RUN rm -rf src/__tests__

USER node

EXPOSE 3001

CMD ["node", "src/server.js"]
