// 起動中のアプリに HTTP で接続し、認証の入口を確かめる（Auth Emulator を使う）。
//   BASE_URL=http://127.0.0.1:3000 node --conditions=react-server scripts/check-http.ts
// Firestore を使う確認は check-firestore.ts で行う。ここではログインと未認証の拒否だけを見る。
import assert from "node:assert/strict";
import { deleteApp, getApps } from "firebase-admin/app";
import { ensureUser, signIn } from "./emulator-users.ts";
import { expectPageRedirect } from "./expect-page.ts";

const base = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const origin = new URL(base).origin;

async function check() {
  try {
    await ensureUser({ uid: "http-check", email: "http-check@example.com", name: "HTTP 確認" });
    const idToken = await signIn("http-check");

    const crossSite = await fetch(`${base}/api/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ idToken }),
    });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.headers.get("set-cookie"), null);

    const bad = await fetch(`${base}/api/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ idToken: "forged" }),
    });
    assert.equal(bad.status, 401);
    assert.deepEqual(await bad.json(), { error: { code: "UNAUTHENTICATED", message: "ログインしてください。" } });

    const login = await fetch(`${base}/api/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ idToken }),
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /__session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=lax/i);
    assert.match(setCookie, /Path=\//);

    for (const [method, path] of [
      ["GET", "/api/courses/math-i"],
      ["GET", "/api/courses/math-i/questions/q1"],
      ["POST", "/api/courses/math-i/join"],
      // 11/8：共通化した生徒用（requireStudentActor）・教員用（requireTeacherActor）の入口
      ["GET", "/api/courses/math-i/questions"],
      ["POST", "/api/courses/math-i/questions"],
      ["GET", "/api/courses/math-i/teacher/questions?status=escalated"],
      ["GET", "/api/courses/math-i/teacher/knowledge"],
      ["POST", "/api/courses/math-i/teacher/knowledge-drafts/q1/dismiss"],
    ] as const) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json", origin },
        ...(method === "POST" ? { body: JSON.stringify({ code: "ABCD-EFGH" }) } : {}),
      });
      assert.equal(response.status, 401, `${method} ${path} without session`);
    }
    const forged = await fetch(`${base}/api/courses/math-i/questions/q1`, { headers: { cookie: "__session=forged" } });
    assert.equal(forged.status, 401);
    const malformed = await fetch(`${base}/api/courses/math-i/questions/q1`, { headers: { cookie: "__session=%E0" } });
    assert.equal(malformed.status, 401);

    const home = await fetch(base, { redirect: "manual" });
    await expectPageRedirect(home, "/login");

    const page = await fetch(`${base}/c/math-i`, { redirect: "manual" });
    await expectPageRedirect(page, "/login?next=%2Fc%2Fmath-i");
    const loginPage = await fetch(`${base}/login`);
    assert.equal(loginPage.status, 200);
    const cookie = setCookie.split(";")[0];
    const signedInLogin = await fetch(`${base}/login?next=${encodeURIComponent("/login?next=/login")}`, {
      redirect: "manual", headers: { cookie },
    });
    await expectPageRedirect(signedInLogin, "/");
    const legacyInvite = await fetch(`${base}/join/math-i?code=ABCD-EFGH`, { redirect: "manual" });
    await expectPageRedirect(legacyInvite, "/join/math-i");
    const invitePage = await fetch(`${base}/join/math-i`, { redirect: "manual" });
    assert.equal(invitePage.status, 200);
    assert.match(await invitePage.text(), /Google でログイン/);

    const logout = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { origin } });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie") ?? "", /__session=;.*Max-Age=0/i);

    console.log("PASS: HTTP でログイン Cookie の属性、別サイトからの要求の拒否、未認証・偽の Cookie の 401、未ログイン時の転送を確認した。");
  } finally {
    await Promise.all(getApps().map(deleteApp));
  }
}

check().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
