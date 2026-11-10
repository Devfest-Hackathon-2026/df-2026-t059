"use client";

import { type FirebaseApp, getApps, initializeApp } from "firebase/app";
import {
  type Auth,
  type User,
  browserPopupRedirectResolver,
  connectAuthEmulator,
  GoogleAuthProvider,
  inMemoryPersistence,
  initializeAuth,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from "firebase/auth";

// ブラウザで使う Firebase SDK はログイン（firebase/auth）だけ。Firestore にはブラウザから接続しない。
// ログイン状態はブラウザに保存せず（inMemoryPersistence）、サーバーの httpOnly Cookie だけで保つ。
// initializeAuth は getAuth と違い依存を自動で入れないため、ポップアップ用の browserPopupRedirectResolver を明示する。
// https://firebase.google.com/docs/auth/web/custom-dependencies

let auth: Auth | null = null;

function getClientAuth(): Auth {
  if (auth) return auth;
  const config = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  };
  // 明示設定がないApp Hostingでは、SDKに埋め込まれた既定設定で初期化する。
  const app: FirebaseApp = getApps()[0] ?? (
    config.apiKey && config.projectId ? initializeApp(config) : initializeApp()
  );
  auth = initializeAuth(app, {
    persistence: inMemoryPersistence,
    popupRedirectResolver: browserPopupRedirectResolver,
  });
  const emulatorHost = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST;
  if (emulatorHost) connectAuthEmulator(auth, `http://${emulatorHost}`, { disableWarnings: true });
  return auth;
}

async function clearClientUser(clientAuth: Auth, user: User): Promise<void> {
  // キャンセル後のポップアップが遅れて完了しても、別の試行の利用者は消さない。
  if (clientAuth.currentUser === user) await signOut(clientAuth).catch(() => undefined);
}

async function exchangeSession(clientAuth: Auth, user: User): Promise<void> {
  try {
    const idToken = await user.getIdToken();
    const response = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    if (!response.ok) throw new Error("セッションを作成できませんでした。");
  } finally {
    await clearClientUser(clientAuth, user);
  }
}

export async function signInWithGoogle(signal: AbortSignal, onPopupSuccess: () => void): Promise<void> {
  const clientAuth = getClientAuth();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  const { user } = await signInWithPopup(clientAuth, provider, browserPopupRedirectResolver);
  if (signal.aborted) {
    await clearClientUser(clientAuth, user);
    return;
  }
  onPopupSuccess();
  await exchangeSession(clientAuth, user);
}

export async function signInWithPassword(email: string, password: string): Promise<void> {
  const clientAuth = getClientAuth();
  const { user } = await signInWithEmailAndPassword(clientAuth, email, password);
  await exchangeSession(clientAuth, user);
}

export async function signOutEverywhereOnThisDevice(): Promise<void> {
  const response = await fetch("/api/auth/logout", { method: "POST" });
  if (!response.ok) throw new Error("ログアウトできませんでした。");
}
