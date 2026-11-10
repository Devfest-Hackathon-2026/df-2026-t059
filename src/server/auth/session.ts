import "server-only";
import type { DecodedIdToken } from "firebase-admin/auth";
import { RECENT_SIGN_IN_MS, SESSION_DURATION_MS } from "../../domain/limits.ts";
import { unauthenticated } from "../errors.ts";
import { getAuthAdmin } from "../firestore/admin.ts";
import { normalizeEmail, type Principal } from "./access.ts";

// Firebase Authentication の ID トークンを httpOnly のセッション Cookie に交換し、以降はその Cookie を検証する。
// ブラウザが送る uid・役割・メールアドレスは使わない。

/** Firebase App Hosting / Hosting の慣例に合わせた Cookie 名。 */
export const SESSION_COOKIE = "__session";

const usingAuthEmulator = () => !!process.env.FIREBASE_AUTH_EMULATOR_HOST;

/** Auth Emulator では検証スクリプトのカスタムトークンも受け付ける。 */
function assertProvider(token: DecodedIdToken) {
  const provider = token.firebase?.sign_in_provider;
  if (provider === "google.com" || provider === "password") return;
  if (provider === "custom" && usingAuthEmulator()) return;
  throw unauthenticated();
}

export function principalFromToken(token: DecodedIdToken): Principal {
  return {
    uid: token.uid,
    email: token.email && token.email_verified ? normalizeEmail(token.email) : null,
    name: typeof token.name === "string" && token.name.trim() ? token.name.trim() : null,
  };
}

/** ログイン直後の ID トークンを検証し、セッション Cookie の値を作る。 */
export async function createSessionCookie(idToken: string): Promise<{ value: string; maxAgeSeconds: number }> {
  const auth = getAuthAdmin();
  let decoded: DecodedIdToken;
  try {
    decoded = await auth.verifyIdToken(idToken, true);
  } catch {
    throw unauthenticated();
  }
  assertProvider(decoded);
  // 盗まれた古いトークンを長期の Cookie に交換させないため、ログイン直後だけ受け付ける。
  if (Date.now() - decoded.auth_time * 1000 > RECENT_SIGN_IN_MS) throw unauthenticated();
  const value = await auth.createSessionCookie(idToken, { expiresIn: SESSION_DURATION_MS });
  return { value, maxAgeSeconds: Math.floor(SESSION_DURATION_MS / 1000) };
}

/** セッション Cookie を検証する。無効・期限切れ・失効済みなら null。 */
export async function verifySessionCookie(value: string | undefined | null): Promise<Principal | null> {
  if (!value) return null;
  try {
    const decoded = await getAuthAdmin().verifySessionCookie(value, true);
    assertProvider(decoded);
    return principalFromToken(decoded);
  } catch {
    return null;
  }
}

export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}
