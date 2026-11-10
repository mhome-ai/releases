# Desktop needs WebKitGTK 4.1. Keep Native's Debian 11/glibc 2.31 image unchanged.
FROM rust:1.95.0-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1
RUN apt-get -o Acquire::Retries=3 update \
    && apt-get install -y --no-install-recommends \
      ca-certificates curl git pkg-config build-essential file python3 \
      libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
      libssl-dev patchelf squashfs-tools xdg-utils dbus-x11 xvfb xauth x11-utils \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; case "$(dpkg --print-architecture)" in arm64) arch=arm64;; amd64) arch=x64;; *) exit 1;; esac; \
    curl -fsSL --retry 3 "https://nodejs.org/dist/v22.22.2/node-v22.22.2-linux-${arch}.tar.xz" -o /tmp/node.tar.xz; \
    curl -fsSL --retry 3 https://nodejs.org/dist/v22.22.2/SHASUMS256.txt -o /tmp/SHASUMS256.txt; \
    awk -v f="node-v22.22.2-linux-${arch}.tar.xz" '$2==f {print $1 "  /tmp/node.tar.xz"}' /tmp/SHASUMS256.txt | sha256sum -c -; \
    tar -xJf /tmp/node.tar.xz --strip-components=1 -C /usr/local; \
    rm /tmp/node.tar.xz /tmp/SHASUMS256.txt
COPY install-sccache.sh /tmp/install-sccache.sh
RUN bash /tmp/install-sccache.sh && rm /tmp/install-sccache.sh
COPY --chmod=755 rustc-registry-cache.py /usr/local/bin/rustc-registry-cache.py
COPY compiler-cache-config.toml /home/runner/.config/sccache/config
RUN useradd -m -u 1001 runner && chown -R 1001:1001 /home/runner \
    && rustup component add clippy rustfmt \
    && chmod -R a+rX /usr/local/rustup
USER 1001:1001
ENV HOME=/home/runner CARGO_HOME=/home/runner/.cargo
WORKDIR /home/runner
