#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
repo="$PWD"
demo_project=demo-gdgoc-japan-hackathon-2026
source_commit="$(node -p 'require("./docs/hackathon/gemini-eval-baseline.json").sourceCommit')"

if [[ "${1:-}" == prepare && "$#" == 1 ]]; then
  # 評価中の作業ツリーや .env.local を使わず、配信中と同じコミットを別領域でビルドする。
  app_dir="$(mktemp -d "${TMPDIR:-/tmp}/gemini-eval-app.XXXXXX")"
  git archive "$source_commit" | tar -xf - -C "$app_dir"
  (
    cd "$app_dir"
    npm ci --prefer-offline --no-audit --no-fund
    export GCLOUD_PROJECT="$demo_project" GOOGLE_CLOUD_PROJECT="$demo_project"
    export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
    export NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 NEXT_PUBLIC_FIREBASE_API_KEY=demo-api-key
    export NEXT_PUBLIC_FIREBASE_PROJECT_ID="$demo_project" NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN="$demo_project.firebaseapp.com"
    export NEXT_TELEMETRY_DISABLED=1 AI_MODE=fixture
    npm run build
  ) >&2
  printf '%s\n' "$source_commit" > "$app_dir/.gemini-eval-app-source"
  printf '%s\n' "$app_dir"
  exit
fi

if [[ "${1:-}" == run && "$#" == 4 ]]; then
  export GEMINI_EVAL_APP_MODE="$2" GEMINI_EVAL_APP_DIR="$(realpath "$3")" GEMINI_MODEL="$4"
  export GCLOUD_PROJECT="$demo_project"
  case "$GEMINI_EVAL_APP_MODE" in --mock|--approved) ;; *) exit 2 ;; esac
  case "$GEMINI_MODEL" in gemini-3.1-flash-lite|gemini-3.5-flash-lite|gemini-3.5-flash|gemini-3.8-flash) ;; *) exit 2 ;; esac
  if [[ "$(cat "$GEMINI_EVAL_APP_DIR/.gemini-eval-app-source")" != "$source_commit" ]]; then
    echo 'Use a local build produced by the prepare command.' >&2
    exit 2
  fi
  exec firebase emulators:exec --project "$demo_project" --only firestore,auth \
    'bash scripts/gemini-eval-app-local.sh exercise'
fi

if [[ "${1:-}" != exercise || "$#" != 1 || "${GCLOUD_PROJECT:-}" != "$demo_project" \
      || -z "${FIRESTORE_EMULATOR_HOST:-}" || -z "${FIREBASE_AUTH_EMULATOR_HOST:-}" ]]; then
  echo "Usage: $0 prepare; $0 run --mock|--approved <prepared-directory> <approved-model-id>" >&2
  exit 2
fi

export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
export AI_MODE=vertex VERTEX_AI_LOCATION=global NEXT_TELEMETRY_DISABLED=1
export NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1
export GEMINI_EVAL_APP_URL=http://127.0.0.1:3102
case "${GEMINI_EVAL_APP_MODE:-}" in
  --mock) export GOOGLE_CLOUD_PROJECT=mock-gemini-eval GOOGLE_VERTEX_BASE_URL=http://127.0.0.1:3198 ;;
  --approved) export GOOGLE_CLOUD_PROJECT=hackathon-513708 GOOGLE_VERTEX_BASE_URL=http://127.0.0.1:3199 ;;
  *) exit 2 ;;
esac

token_pid=
app_pid=
adc_file="$(mktemp)"
cleanup() {
  if [[ -n "$app_pid" ]]; then kill "$app_pid" 2>/dev/null || true; wait "$app_pid" 2>/dev/null || true; fi
  if [[ -n "$token_pid" ]]; then kill "$token_pid" 2>/dev/null || true; wait "$token_pid" 2>/dev/null || true; fi
  rm -f -- "$adc_file"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# SDK の認証処理もローカルに固定する。有効な Google 資格情報はアプリに渡さない。
cat > "$adc_file" <<'FAKE_ADC'
{"type":"external_account_authorized_user","client_id":"synthetic","client_secret":"synthetic","refresh_token":"synthetic","token_url":"http://127.0.0.1:3198/token"}
FAKE_ADC
export GOOGLE_APPLICATION_CREDENTIALS="$adc_file"
unset GOOGLE_API_KEY GEMINI_API_KEY

node scripts/gemini-eval-app-local-service.ts "$GEMINI_EVAL_APP_MODE" &
token_pid=$!
node "$GEMINI_EVAL_APP_DIR/node_modules/next/dist/bin/next" start "$GEMINI_EVAL_APP_DIR" --hostname 127.0.0.1 --port 3102 &
app_pid=$!

for attempt in {1..60}; do
  kill -0 "$token_pid" "$app_pid"
  if curl --fail --silent --max-time 1 http://127.0.0.1:3198/health >/dev/null \
    && curl --fail --silent --max-time 1 "$GEMINI_EVAL_APP_URL/login" >/dev/null; then
    node --conditions=react-server "$repo/scripts/gemini-eval-app-smoke.ts"
    exit
  fi
  sleep 1
done
echo 'Local application or test token endpoint did not become ready.' >&2
exit 1
