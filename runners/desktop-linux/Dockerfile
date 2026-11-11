# Desktop needs WebKitGTK 4.1. Keep Native's Debian 11/glibc 2.31 image unchanged.
FROM rust:1.95.0-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1
RUN apt-get -o Acquire::Retries=3 update \
    && apt-get install -y --no-install-recommends \
      ca-certificates curl git pkg-config build-essential file python3 \
      libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
      libssl-dev patchelf squashfs-tools xdg-utils dbus-x11 xvfb xauth x11-utils \
    && rm -rf /var/lib/apt/lists/*
# Node 22 security release; archive SHA-256 values are pinned from its signed SHASUMS.
ARG NODE_VERSION=22.23.4
RUN set -eu; case "$(dpkg --print-architecture)" in \
      arm64) arch=arm64; sha256=6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b;; \
      amd64) arch=x64; sha256=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce;; \
      *) exit 1;; \
    esac; \
    curl -fsSL --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" -o /tmp/node.tar.xz; \
    echo "${sha256}  /tmp/node.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/node.tar.xz --strip-components=1 -C /usr/local; \
    rm /tmp/node.tar.xz
COPY install-sccache.sh /tmp/install-sccache.sh
RUN bash /tmp/install-sccache.sh && rm /tmp/install-sccache.sh
COPY --chmod=755 rustc-registry-cache.py /usr/local/bin/rustc-registry-cache.py
COPY compiler-cache-config.toml /home/runner/.config/sccache/config
RUN useradd -m -u 1001 runner \
    && mkdir -p /home/runner/.cache \
    && ln -s /home/runner/.mhome/cache/desktop-tools /home/runner/.cache/tauri \
    && printf 'cache=/home/runner/.mhome/cache/npm\n' > /home/runner/.npmrc \
    && chown -R 1001:1001 /home/runner \
    && rustup component add clippy rustfmt \
    && chmod -R a+rX /usr/local/rustup
USER 1001:1001
ENV HOME=/home/runner CARGO_HOME=/home/runner/.cargo
WORKDIR /home/runner
