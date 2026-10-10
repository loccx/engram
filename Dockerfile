# Engram as a self-hosted, multi-tenant memory service.
#
# The daemon refuses to start on a non-loopback bind without a bearer token, so
# ENGRAM_ALLOW_NONLOCAL=1 and ENGRAM_AUTH_TOKEN (or ENGRAM_AUTH_TOKEN_FILE) must
# be supplied together. That refusal is deliberate: do not work around it by
# editing the image, supply the token.
#
#   docker build -t engram .
#   docker run -p 8888:8888 -v engram-data:/data \
#     -e ENGRAM_ALLOW_NONLOCAL=1 -e ENGRAM_AUTH_TOKEN=<a-long-random-token> engram
#
# Then:  curl -H "Authorization: Bearer $TOKEN" localhost:8888/health
#        MCP is served at POST /mcp
#
# Storage is SQLite in /data, so one instance owns that volume. Horizontal scale
# needs a shared store, which this image does not provide.

FROM node:24-bookworm-slim

# better-sqlite3 resolves a prebuilt binary for this platform; keep the toolchain
# available so a source build still succeeds on an architecture without one.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# the whole tree before npm ci, not just the manifests: package.json declares
# `prepare: npm run build`, which npm runs as part of `ci`, so tsc needs the
# source and tsconfig present or the install fails with tsc printing its help.
# That is why there is no separate cached dependency layer here.
COPY . .

# the require is a build-time guard: better-sqlite3 resolves a native binary in a
# postinstall, and a blocked or failed one would otherwise produce an image that
# builds cleanly and dies on first use.
RUN npm ci \
  && node -e "require('better-sqlite3'); console.log('better-sqlite3 native binding ok')" \
  && npm prune --omit=dev

# the daemon writes its pid, database and vector cache under the data dir
ENV ENGRAM_DATA_DIR=/data \
    ENGRAM_ALLOW_NONLOCAL=1 \
    NODE_ENV=production

RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 8888

# a non-loopback bind needs the token, so the probe carries it.
# podman builds OCI by default and silently DROPS this directive ("HEALTHCHECK is
# not supported for OCI image format"); build with `podman build --format docker`
# to keep it. docker build honours it as written, and kubernetes ignores it in
# favour of its own probes, so this is a convenience rather than the contract.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8888/health',{headers:{authorization:'Bearer '+(process.env.ENGRAM_AUTH_TOKEN||'')}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js", "start", "--port", "8888"]
