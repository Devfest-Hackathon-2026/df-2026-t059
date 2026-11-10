// Auth Emulator でログイン → セッション Cookie → 検証の流れを確かめる。npm run check:auth
import assert from "node:assert/strict";
import { deleteApp, getApps } from "firebase-admin/app";
import { createSessionCookie, verifySessionCookie } from "../src/server/auth/session.ts";
import { getAuthAdmin } from "../src/server/firestore/admin.ts";
import { ensureUser, signIn } from "./emulator-users.ts";

if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Run this check against the Auth Emulator.");

async function check() {
  try {
    await ensureUser({ uid: "check-student", email: "Student@Example.com", name: "テスト 生徒" });
    await ensureUser({ uid: "check-unverified", email: "unverified@example.com", name: null, emailVerified: false });

    const session = await createSessionCookie(await signIn("check-student"));
    const principal = await verifySessionCookie(session.value);
    assert.deepEqual(principal, { uid: "check-student", email: "student@example.com", name: "テスト 生徒" });
    assert.equal(session.maxAgeSeconds, 5 * 24 * 60 * 60);

    // 未検証のメールは教員判定・本人表示に使わない（email=null）。
    const unverified = await verifySessionCookie((await createSessionCookie(await signIn("check-unverified"))).value);
    assert.deepEqual(unverified, { uid: "check-unverified", email: null, name: null });

    // 改ざん・空の Cookie、偽の ID トークンは受け付けない。
    assert.equal(await verifySessionCookie(`${session.value}x`), null);
    assert.equal(await verifySessionCookie(""), null);
    await assert.rejects(createSessionCookie("not-a-token"), /ログイン/);

    // 失効させたセッションは使えない（別端末のログアウトとは別。管理側での強制失効）。
    // 失効の判定は秒単位なので、ログインと別の秒に失効させる。
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await getAuthAdmin().revokeRefreshTokens("check-student");
    assert.equal(await verifySessionCookie(session.value), null);

    console.log("PASS: Auth Emulator でログイン・セッション Cookie の発行と検証、無効な Cookie の拒否を確認した。");
  } finally {
    await Promise.all(getApps().map(deleteApp));
  }
}

check().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
