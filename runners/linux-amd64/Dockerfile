# Match GitHub-hosted linux-x64 CI: ubuntu-24.04.
# On Apple Silicon this image must run as linux/amd64 with Rosetta.
FROM ubuntu:24.04
USER root

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# Same native build packages as baycat linux CI, plus runner/node-gyp extras.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        cmake \
        curl \
        file \
        git \
        jq \
        libayatana-appindicator3-dev \
        libdbus-1-dev \
        libglib2.0-dev \
        libgtk-3-dev \
        libicu74 \
        libpcap-dev \
        libsqlite3-dev \
        libssl-dev \
        pkg-config \
        protobuf-compiler \
        python3 \
        python3-setuptools \
        python3-venv \
        sudo \
        tar \
        unzip \
        xz-utils \
        zstd \
    && rm -rf /var/lib/apt/lists/*

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

RUN useradd --create-home --uid 1001 --shell /bin/bash runner \
    && echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner \
    && chmod 440 /etc/sudoers.d/runner

COPY --chmod=755 entrypoint.sh /usr/local/bin/linux-amd64-runner-entrypoint.sh

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
