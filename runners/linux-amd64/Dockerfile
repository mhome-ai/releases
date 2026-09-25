# Debian 11 is the Linux native glibc baseline (2.31). Binaries built here
# load on Debian 11 and on newer glibc systems. On Apple Silicon this image
# must run as linux/amd64 with Rosetta. The Actions runner accepts bullseye's
# libicu67 and libssl1.1.
FROM debian:11
USER root

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# libsqlite3-dev stays out: sqlx bundles SQLite, and bullseye's 3.34 lacks
# SQL we already use. libssl-dev stays out so a crate cannot link OpenSSL by
# accident. libssl1.1 is only for the Actions runner's .NET host.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        cmake \
        curl \
        file \
        git \
        jq \
        libarchive-tools \
        libayatana-appindicator3-dev \
        libdbus-1-dev \
        libglib2.0-dev \
        libgtk-3-dev \
        libicu67 \
        libkrb5-3 \
        liblttng-ust0 \
        libpcap-dev \
        libssl1.1 \
        openssh-client \
        pkg-config \
        protobuf-compiler \
        python3 \
        python3-setuptools \
        python3-venv \
        sudo \
        tar \
        unzip \
        xz-utils \
        zlib1g \
        zstd \
    && rm -rf /var/lib/apt/lists/*

# Bullseye has no minisign package. Upstream 0.12 Linux binaries are static.
ARG MINISIGN_VERSION=0.12
ARG MINISIGN_SHA256=9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73
RUN curl -fsSL "https://github.com/jedisct1/minisign/releases/download/${MINISIGN_VERSION}/minisign-${MINISIGN_VERSION}-linux.tar.gz" \
      -o /tmp/minisign.tar.gz \
    && echo "${MINISIGN_SHA256}  /tmp/minisign.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/minisign.tar.gz -C /tmp \
    && mv /tmp/minisign-linux/x86_64/minisign /usr/local/bin/minisign \
    && chmod 755 /usr/local/bin/minisign \
    && rm -rf /tmp/minisign.tar.gz /tmp/minisign-linux

ARG NODE_VERSION=20.20.2
# nodejs.org publishes this archive as linux-x64; our platform id is linux-amd64.
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      -o /tmp/node.tar.xz \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o /tmp/SHASUMS256.txt \
    && awk -v f="node-v${NODE_VERSION}-linux-x64.tar.xz" '$2==f {print $1 "  /tmp/node.tar.xz"}' /tmp/SHASUMS256.txt \
      | sha256sum -c - \
    && mkdir -p /usr/local/lib/nodejs \
    && tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs \
    && ln -s "/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-x64/bin/node" /usr/local/bin/node \
    && ln -s "/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-x64/bin/npm" /usr/local/bin/npm \
    && ln -s "/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-x64/bin/npx" /usr/local/bin/npx \
    && rm -f /tmp/node.tar.xz /tmp/SHASUMS256.txt

ARG GH_VERSION=2.100.0
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
      -o /tmp/gh.tar.gz \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && mv "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
    && rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_amd64"

ARG DOCKER_VERSION=27.5.1
RUN curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" \
      -o /tmp/docker.tgz \
    && tar -xzf /tmp/docker.tgz -C /tmp \
    && mv /tmp/docker/docker /usr/local/bin/docker \
    && rm -rf /tmp/docker /tmp/docker.tgz

RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscliv2.zip

RUN useradd --create-home --uid 1001 --shell /bin/bash runner \
    && echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner \
    && chmod 440 /etc/sudoers.d/runner

COPY --chmod=755 linux-amd64/entrypoint.sh /usr/local/bin/linux-amd64-runner-entrypoint.sh
COPY --chmod=755 ensure-mhome-sources.sh /usr/local/bin/ensure-mhome-sources.sh

USER runner
WORKDIR /home/runner
ENV HOME=/home/runner \
    USER=runner \
    CARGO_HOME=/home/runner/.cargo \
    RUSTUP_HOME=/home/runner/.rustup \
    CARGO_TARGET_DIR=/home/runner/.cache/cargo-target \
    MHOME_DOWNLOAD_CACHE_ROOT=/home/runner/.cache/mhome-downloads \
    CARGO_TERM_COLOR=always \
    PATH=/home/runner/.cargo/bin:/usr/local/bin:/usr/bin:/bin

ENTRYPOINT ["/usr/local/bin/linux-amd64-runner-entrypoint.sh"]
