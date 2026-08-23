# PocketBase for ais-teams.
#
# Two stages: the first fetches and verifies the release archive, the second is
# a bare runtime holding only the binary and this project's migrations. Keeping
# the download out of the final layer means no curl, no unzip and no archive in
# the shipped image.
#
# The version is pinned on purpose. PocketBase makes breaking schema-API changes
# between minor releases, and the migrations in pb_migrations/ are written
# against the v0.23+ `fields` API. Bump deliberately, not by rebuilding.

ARG PB_VERSION=0.40.0

# --------------------------------------------------------------- fetch stage
FROM alpine:3.21 AS fetch

ARG PB_VERSION
# Set automatically by BuildKit; lets the same Dockerfile build for arm64 hosts.
ARG TARGETARCH

RUN apk add --no-cache ca-certificates unzip wget

WORKDIR /out

# PocketBase publishes per-arch zips: pocketbase_<version>_linux_<arch>.zip
RUN case "${TARGETARCH}" in \
      amd64)  PB_ARCH=amd64  ;; \
      arm64)  PB_ARCH=arm64  ;; \
      arm)    PB_ARCH=armv7  ;; \
      *)      echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    wget -q -O pb.zip \
      "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${PB_ARCH}.zip" \
    && unzip -q pb.zip pocketbase \
    && rm pb.zip \
    && chmod +x pocketbase \
    && ./pocketbase --version

# ------------------------------------------------------------- runtime stage
FROM alpine:3.21

ARG PB_VERSION

LABEL org.opencontainers.image.title="ais-teams-pocketbase" \
      org.opencontainers.image.description="PocketBase backend for ais-teams" \
      org.opencontainers.image.version="${PB_VERSION}"

# ca-certificates: OAuth and any outbound call from a JS hook need a trust store.
# wget: used by the healthcheck below. su-exec: privilege drop in the entrypoint.
RUN apk add --no-cache ca-certificates wget tzdata su-exec \
    && addgroup -S pocketbase \
    && adduser -S -G pocketbase -h /pb pocketbase

COPY --from=fetch /out/pocketbase /usr/local/bin/pocketbase
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Baked in so the image is self-contained: a fresh container applies the whole
# schema on first boot with no bind mount. docker-compose still mounts these
# over the top during development so edits apply without a rebuild.
COPY --chown=pocketbase:pocketbase pb_migrations /pb_migrations
COPY --chown=pocketbase:pocketbase pb_hooks /pb_hooks

# pb_data is a volume in every real deployment; this only guarantees the
# mountpoint exists and is writable when it is not.
RUN mkdir -p /pb_data /pb_public \
    && chown -R pocketbase:pocketbase /pb_data /pb_public

# Deliberately root: the entrypoint fixes ownership of an inherited pb_data
# volume and then drops to `pocketbase` via su-exec. Pass --user to skip that.
WORKDIR /pb

EXPOSE 8090
VOLUME ["/pb_data"]

# 127.0.0.1 on purpose: this checks the server inside the container, and works
# regardless of what the port is published as outside it.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
    CMD wget --spider -q http://127.0.0.1:8090/api/health || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["serve", \
     "--http=0.0.0.0:8090", \
     "--dir=/pb_data", \
     "--publicDir=/pb_public", \
     "--hooksDir=/pb_hooks", \
     "--migrationsDir=/pb_migrations"]
