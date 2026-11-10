#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Repair cache volume ownership after Dev Containers adjusts the Linux UID/GID.
sudo chown -R "$(id -u):$(id -g)" "$HOME/.npm" "$HOME/.cache/firebase"

if [[ ! -e .env.local ]]; then
  cp .env.example .env.local
fi

npm ci

firebase setup:emulators:firestore

printf '\n%s\n' 'Ready. Start Firestore with: npm run emulators'
