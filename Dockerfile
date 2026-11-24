# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
ARG RUST_IMAGE=rust:1.99.1-bookworm@sha256:e6f2cff35d0f309acf8433b4f05878ed77092602c5065cc81801177da0bb3a9c

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS web
ARG NODE_OPTIONS=--max-old-space-size=4096
WORKDIR /build
COPY examples/hdoc/admin-app examples/hdoc/admin-app
COPY examples/hdoc/editor examples/hdoc/editor
COPY examples/hdoc/xlsx-univer-viewer examples/hdoc/xlsx-univer-viewer
COPY examples/hdoc/embed-host examples/hdoc/embed-host
COPY crates crates
COPY apps/workspace/scripts/build.mjs apps/workspace/scripts/build.mjs
COPY apps/workspace/src/selection-transport.mjs apps/workspace/src/selection-transport.mjs
RUN --mount=type=cache,target=/root/.npm \
    set -eu; \
    for app in admin-app editor xlsx-univer-viewer embed-host; do \
      npm ci --no-audit --no-fund --prefix "examples/hdoc/$app"; \
    done; \
    OFFICECLI_WORKSPACE_DIST=/out/web node apps/workspace/scripts/build.mjs --web-only; \
    mkdir -p /out/licenses; \
    find examples/hdoc -path '*/node_modules/*' -type f \
      \( -iname 'license*' -o -iname 'licence*' -o -iname 'copying*' -o -iname 'notice*' -o -iname 'ofl*' \) \
      -exec cp --parents -t /out/licenses -- {} +

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS workspace
WORKDIR /build/apps/workspace
COPY apps/workspace/package.json apps/workspace/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY apps/workspace/tsconfig.json apps/workspace/cli.mts ./
COPY apps/workspace/src src
RUN --mount=type=cache,target=/root/.npm \
    npm run build:runtime -- --outDir /out/runtime \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
    && cp -a node_modules /out/runtime/node_modules \
    && mkdir -p /out/licenses \
    && find node_modules -type f \
       \( -iname 'license*' -o -iname 'licence*' -o -iname 'copying*' -o -iname 'notice*' \) \
       -exec cp --parents -t /out/licenses -- {} +

FROM --platform=$BUILDPLATFORM ${RUST_IMAGE} AS engine-source
WORKDIR /build
COPY Cargo.toml Cargo.lock* ./
COPY crates crates
COPY schemas/help schemas/help
COPY skills skills
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    if [ ! -f Cargo.lock ]; then cargo generate-lockfile; fi

FROM engine-source AS engine
ARG BUILDARCH
ARG TARGETARCH
ARG CARGO_BUILD_JOBS=3
COPY --from=web /out/web/admin/index.html examples/hdoc/admin-app/embed/index.html
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target,id=foldly-rust-${TARGETARCH} \
    set -eu; \
    case "$TARGETARCH" in \
      amd64) target=x86_64-unknown-linux-gnu; compiler=x86_64-linux-gnu; gcc=gcc-x86-64-linux-gnu ;; \
      arm64) target=aarch64-unknown-linux-gnu; compiler=aarch64-linux-gnu; gcc=gcc-aarch64-linux-gnu ;; \
      *) echo "Unsupported Linux architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    if [ "$BUILDARCH" != "$TARGETARCH" ]; then \
      apt-get update; \
      apt-get install -y --no-install-recommends "$gcc" "libc6-dev-$TARGETARCH-cross"; \
      rm -rf /var/lib/apt/lists/*; \
      export "CARGO_TARGET_$(printf '%s' "$target" | tr 'a-z-' 'A-Z_')_LINKER=$compiler-gcc"; \
    fi; \
    rustup target add "$target"; \
    cargo build --locked --release --jobs "$CARGO_BUILD_JOBS" --target "$target" -p officecli --bin officecli; \
    install -D -m 0755 "target/$target/release/officecli" /out/officecli; \
    "$compiler-strip" --strip-debug /out/officecli; \
    mkdir -p /out/licenses; \
    cd /usr/local/cargo/registry/src; \
    find . -maxdepth 3 -type f \
      \( -iname 'license*' -o -iname 'licence*' -o -iname 'copying*' -o -iname 'notice*' -o -iname 'ofl*' \) \
      -exec cp --parents -t /out/licenses -- {} +

FROM ${NODE_IMAGE} AS runtime-base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates chromium chromium-sandbox \
       fonts-liberation fonts-noto-cjk fonts-noto-color-emoji gosu poppler-utils \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node -m 0700 /var/lib/foldly

FROM runtime-base AS runtime
LABEL org.opencontainers.image.title="Foldly Workspace" \
      org.opencontainers.image.source="https://github.com/RainLib/Foldly" \
      org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /opt/foldly
ENV OFFICECLI_PDF_BROWSER=/usr/bin/chromium \
    FOLDLY_ROOT=/var/lib/foldly/workspace
COPY LICENSE LICENSE
COPY --from=web /out/licenses/ licenses/npm/
COPY --from=workspace /out/licenses/ licenses/npm/workspace/
COPY --from=engine /out/licenses/ licenses/rust/
COPY crates/pdf-handler/assets/GlyphLessFont-*.txt licenses/pdf/
COPY --from=workspace /out/runtime/ app/
COPY --from=web /out/web/ app/dist/
COPY --from=engine /out/officecli app/dist/officecli
COPY --chmod=755 deploy/workspace/entrypoint.sh /usr/local/bin/foldly
RUN mkdir -p app/dist/blank \
    && for format in docx xlsx pptx; do \
         app/dist/officecli create "app/dist/blank/blank.$format" --locale zh-CN; \
       done

EXPOSE 7400
HEALTHCHECK --interval=10s --timeout=4s --start-period=30s CMD ["foldly", "health"]
ENTRYPOINT ["foldly"]
CMD ["serve"]
