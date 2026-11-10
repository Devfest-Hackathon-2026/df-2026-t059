import "server-only";
import { type App, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const isLocal = () => process.env.NODE_ENV === "development" || !!process.env.GCLOUD_PROJECT?.startsWith("demo-");

function getAdminApp(): App {
  const projectId = process.env.GCLOUD_PROJECT;
  const usingEmulator = !!process.env.FIRESTORE_EMULATOR_HOST || !!process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (usingEmulator && !projectId?.startsWith("demo-")) {
    throw new Error("Set GCLOUD_PROJECT to the demo project ID when using the Firebase Emulators.");
  }
  // App Hosting provides default credentials and Firebase configuration.
  return getApps().find((candidate) => candidate.name === "[DEFAULT]")
    ?? initializeApp(usingEmulator ? { projectId } : undefined);
}

export function getFirestoreAdmin() {
  if (!process.env.FIRESTORE_EMULATOR_HOST && isLocal()) {
    throw new Error("Set FIRESTORE_EMULATOR_HOST for local Firestore access.");
  }
  return getFirestore(getAdminApp());
}

export function getAuthAdmin() {
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST && isLocal()) {
    throw new Error("Set FIREBASE_AUTH_EMULATOR_HOST for local Authentication.");
  }
  return getAuth(getAdminApp());
}
