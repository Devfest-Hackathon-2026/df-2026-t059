#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Keep local development independent of firebase use / production aliases.
args=(
  emulators:start
  --project demo-gdgoc-japan-hackathon-2026
  --only firestore,auth
  --export-on-exit .emulator-data
)

if [[ -f .emulator-data/firebase-export-metadata.json ]]; then
  args+=(--import .emulator-data)
fi

exec firebase "${args[@]}"
