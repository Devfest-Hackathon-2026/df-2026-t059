// 検証スクリプト用：Auth Emulator にテストユーザーを作り、ログイン直後の ID トークンを得る。
// 本物の Google アカウントは使わない。ここで作った主体はサーバー検証スクリプトの中だけで使う。
import { getAuthAdmin } from "../src/server/firestore/admin.ts";

export type TestUser = { uid: string; email: string; name: string | null; emailVerified?: boolean };

export async function ensureUser(user: TestUser) {
  const auth = getAuthAdmin();
  try {
    await auth.deleteUser(user.uid);
  } catch {
    // 未作成なら無視する。
  }
  await auth.createUser({
    uid: user.uid,
    email: user.email,
    emailVerified: user.emailVerified ?? true,
    ...(user.name ? { displayName: user.name } : {}),
  });
}

/** カスタムトークンで Auth Emulator にログインし、ID トークンを得る（Emulator 専用）。 */
export async function signIn(uid: string): Promise<string> {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!host) throw new Error("Run this against the Auth Emulator.");
  const customToken = await getAuthAdmin().createCustomToken(uid);
  const response = await fetch(
    `http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=demo-api-key`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: customToken, returnSecureToken: true }) },
  );
  if (!response.ok) throw new Error(`Auth Emulator sign-in failed: ${response.status}`);
  const body = (await response.json()) as { idToken: string };
  return body.idToken;
}
