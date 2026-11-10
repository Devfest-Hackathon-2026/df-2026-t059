import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { signOutEverywhereOnThisDevice } from "../src/features/auth/firebase-client.ts";
import { fetchWithSession, SESSION_EXPIRED_EVENT } from "../src/features/auth/session-fetch.ts";
import { createStudentClient, StudentApiError } from "../src/features/student/api.ts";
import { needsHistoryDetail } from "../src/features/student/student-view-model.ts";
import { createHttpTeacherClient } from "../src/features/teacher/api/client.ts";
import { TeacherApiError } from "../src/features/teacher/api/errors.ts";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let expirations = 0;
beforeEach(() => {
  expirations = 0;
  const events = new EventTarget();
  events.addEventListener(SESSION_EXPIRED_EVENT, () => expirations++);
  Object.defineProperty(globalThis, "window", { value: events, configurable: true, writable: true });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test("生徒API: JSONでない401でもSessionBoundaryへの通知を1回送る", async () => {
  globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });
  await assert.rejects(createStudentClient("math-i").listThreads(), StudentApiError);
  assert.equal(expirations, 1);
});

test("教員API: 401でSessionBoundaryへの通知を1回送る", async () => {
  globalThis.fetch = async () => Response.json({ error: { code: "UNAUTHENTICATED", message: "ログインしてください。" } }, { status: 401 });
  await assert.rejects(createHttpTeacherClient("math-i").listThreads("escalated"), TeacherApiError);
  assert.equal(expirations, 1);
});

test("再ログイン後の成功応答は通常どおり返し、期限切れの通知を出さない", async () => {
  globalThis.fetch = async () => Response.json({ data: [] });
  assert.deepEqual(await createStudentClient("math-i").listThreads(), []);
  assert.deepEqual(await createHttpTeacherClient("math-i").listDrafts(), []);
  assert.equal(expirations, 0);
});

test("404と500をログイン切れと誤認しない", async () => {
  for (const status of [404, 500]) {
    globalThis.fetch = async () => new Response(null, { status });
    await assert.rejects(createStudentClient("math-i").listThreads(), StudentApiError);
    await assert.rejects(createHttpTeacherClient("math-i").listDrafts(), TeacherApiError);
  }
  assert.equal(expirations, 0);
});

test("windowがない実行環境でも401をそのまま返せる", async () => {
  Reflect.deleteProperty(globalThis, "window");
  globalThis.fetch = async () => new Response(null, { status: 401 });
  assert.equal((await fetchWithSession("/api/courses")).status, 401);
});

test("ログアウトAPIの500や通信失敗を成功扱いにしない", async () => {
  globalThis.fetch = async () => new Response(null, { status: 500 });
  await assert.rejects(signOutEverywhereOnThisDevice(), /ログアウトできませんでした/);
  globalThis.fetch = async () => { throw new TypeError("network failure"); };
  await assert.rejects(signOutEverywhereOnThisDevice(), /network failure/);
  globalThis.fetch = async () => new Response(null, { status: 200 });
  await signOutEverywhereOnThisDevice();
});

test("生徒の履歴は一覧より新しい会話の詳細をそのまま使う", () => {
  const listed = { status: "teacher_answered", resolvedAt: null, updatedAt: "2026-11-10T10:00:00.000Z" } as const;
  assert.equal(needsHistoryDetail(listed, { updatedAt: "2026-11-10T10:00:01.000Z" }), false);
  assert.equal(needsHistoryDetail(listed, { updatedAt: listed.updatedAt }), false);
  assert.equal(needsHistoryDetail(listed, { updatedAt: "2026-11-10T09:59:59.000Z" }), true);
  assert.equal(needsHistoryDetail(listed), true);
  assert.equal(needsHistoryDetail({ ...listed, status: "escalated" }), false);
});
