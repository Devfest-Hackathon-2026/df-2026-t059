import { defineConfig } from "@playwright/test";

const project = "demo-gdgoc-japan-hackathon-2026";
const baseURL = "http://127.0.0.1:3100";
const firestore = "127.0.0.1:8080";
const auth = "127.0.0.1:9099";

export default defineConfig({
  testDir: ".",
  workers: 1,
  reporter: "list",
  outputDir: "../../test-results",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: { baseURL, actionTimeout: 15_000, trace: "retain-on-failure" },
  webServer: {
    cwd: "../..",
    command: `npm run build && firebase emulators:exec --only firestore,auth --project ${project} "npm run start -- --port 3100"`,
    url: `${baseURL}/login`,
    timeout: 240_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    env: {
      AI_MODE: "fixture",
      GOOGLE_CLOUD_PROJECT: project,
      GCLOUD_PROJECT: project,
      FIRESTORE_EMULATOR_HOST: firestore,
      FIREBASE_AUTH_EMULATOR_HOST: auth,
      NEXT_PUBLIC_FIREBASE_API_KEY: "demo-api-key",
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: project,
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: `${project}.firebaseapp.com`,
      NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: auth,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
