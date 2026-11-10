# Development image only. Firebase App Hosting builds the Next.js app separately.
FROM mcr.microsoft.com/devcontainers/javascript-node:5-24-trixie

USER root

ARG NPM_VERSION=10.9.4
ARG FIREBASE_TOOLS_VERSION=15.34.2

# Firestore Emulator requires Java 21. Debian trixie provides it on amd64/arm64.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-21-jre-headless \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install the pinned npm first so CLI dependencies use the same installer.
RUN npm install --global "npm@${NPM_VERSION}"

RUN npm install --global "firebase-tools@${FIREBASE_TOOLS_VERSION}" \
    && npm cache clean --force

# Named volumes inherit these directories' ownership on first use.
RUN mkdir -p /home/node/.npm /home/node/.cache/firebase \
    && chown -R node:node /home/node/.npm /home/node/.cache/firebase

ENV NEXT_TELEMETRY_DISABLED=1

USER node
