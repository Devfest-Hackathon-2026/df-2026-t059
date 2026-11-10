import { expect, type Page, test } from "@playwright/test";
import type { ApiSuccess, InviteDTO, StudentThreadDetailDTO } from "../../src/domain/course-workflow.ts";

async function createCourseForEnrolledUser(page: Page, baseURL: string | undefined) {
  if (!baseURL || new URL(baseURL).hostname !== "127.0.0.1") throw new Error("Use the local browser test server.");
  const sub = crypto.randomUUID();
  // Auth Emulator accepts a mock Google ID token. The application issues the actual test session Cookie.
  const idp = await page.request.post("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=demo-api-key", {
    data: {
      requestUri: baseURL,
      returnSecureToken: true,
      postBody: new URLSearchParams({
        providerId: "google.com",
        id_token: JSON.stringify({ sub, email: `${sub}@example.test`, email_verified: true, name: "回帰テスト利用者" }),
      }).toString(),
    },
  });
  expect(idp.ok()).toBeTruthy();
  const { idToken } = await idp.json();
  const headers = { origin: new URL(baseURL).origin };
  const session = await page.request.post("/api/auth/session", { headers, data: { idToken } });
  expect(session.ok()).toBeTruthy();
  const course = await page.request.post("/api/courses", { headers, data: { name: "画面回帰の講義", requestId: crypto.randomUUID() } });
  expect(course.status()).toBe(201);
  const { data: { id } } = await course.json() as ApiSuccess<{ id: string }>;
  const courseApi = `/api/courses/${id}`;
  const invite = await page.request.post(`${courseApi}/teacher/invite`, { headers });
  expect(invite.status()).toBe(201);
  const { data: { code } } = await invite.json() as ApiSuccess<InviteDTO>;
  const joined = await page.request.post(`${courseApi}/join`, { headers, data: { code } });
  expect(joined.ok()).toBeTruthy();
  return { courseApi, studentUrl: `/c/${id}` };
}

const timestamp = "2026-11-10T10:00:00.000Z";

function thread(id: string, title: string, text: string): StudentThreadDetailDTO {
  return {
    id, title, categoryIds: ["other"], status: "ai_answered", resolvedAt: null,
    createdAt: timestamp, updatedAt: timestamp, summaryStatus: "none", escalatedBy: null,
    messages: [{ id: `${id}-1`, role: "student", text, sequence: 1, createdAt: timestamp }],
    actions: {
      canSendMessage: true, canEscalate: true, canResolve: true, canRetryAi: false,
      canRequestRegeneration: false, canRetrySummary: false,
    },
  };
}

test("一覧の取得後に質問が更新されても、履歴が表示され本文を検索できる", async ({ page, baseURL }) => {
  const { courseApi, studentUrl } = await createCourseForEnrolledUser(page, baseURL);
  const { messages, actions, escalatedBy, ...summary } = thread("resolved", "解決した例題", "検索対象のヒント");
  const listed = { ...summary, resolvedAt: timestamp };
  await page.route((url) => url.pathname === `${courseApi}/questions`, (route) => route.fulfill({ json: { data: [listed] } }));
  let reads = 0;
  await page.route((url) => url.pathname === `${courseApi}/questions/${listed.id}`, async (route) => {
    reads++;
    await route.fulfill({ json: { data: { ...listed, messages, actions, escalatedBy, updatedAt: "2026-11-10T10:00:01.000Z" } } });
  });

  await page.goto(`${studentUrl}?view=history`);
  const search = page.getByRole("searchbox", { name: "キーワード検索" });
  await search.fill("検索対象のヒント");
  await expect(page.getByRole("button", { name: /解決した例題/ })).toBeVisible();
  await expect(page.getByText("質問の履歴を読み込んでいます。")).toBeHidden();
  expect(reads).toBe(1);
});

test("前の質問の送信完了は現在開いている質問の読み込みを取り消さない", async ({ page, baseURL }) => {
  const { courseApi, studentUrl } = await createCourseForEnrolledUser(page, baseURL);
  const first = thread("first", "先に開く質問", "最初の質問です。");
  const second = thread("second", "あとで開く質問", "別の会話です。");
  const listUrl = `${courseApi}/questions`;
  const sendUrl = `${listUrl}/${first.id}/messages`;
  const secondUrl = `${listUrl}/${second.id}`;
  const sendGate = Promise.withResolvers<void>();
  const readGate = Promise.withResolvers<void>();
  await page.route((url) => url.pathname === listUrl, (route) => route.fulfill({ json: { data: [first, second] } }));
  await page.route((url) => url.pathname === `${listUrl}/${first.id}`, (route) => route.fulfill({ json: { data: first } }));
  await page.route((url) => url.pathname === sendUrl, async (route) => {
    await sendGate.promise;
    await route.fulfill({ json: { data: first } });
  });
  await page.route((url) => url.pathname === secondUrl, async (route) => {
    await readGate.promise;
    await route.fulfill({ json: { data: second } });
  });

  try {
    await page.goto(`${studentUrl}?question=${first.id}`);
    const composer = page.getByPlaceholder("続けて質問する");
    await composer.fill("送信中に会話を切り替えます。");
    const sent = page.waitForRequest((request) => new URL(request.url()).pathname === sendUrl);
    await page.getByRole("button", { name: "送信", exact: true }).click();
    await sent;
    const reading = page.waitForRequest((request) => new URL(request.url()).pathname === secondUrl);
    await page.getByRole("button", { name: second.title, exact: true }).click();
    await reading;
    await expect(page.getByText("処理しています…")).toBeVisible();

    sendGate.resolve();
    await expect(page.getByText("処理しています…")).toBeHidden();
    readGate.resolve();
    await expect(page.getByRole("heading", { name: second.title })).toBeVisible({ timeout: 4_000 });
    await expect(page.getByText(second.messages[0].text)).toBeVisible();

    // 一度表示した会話でも、再取得が404なら古い本文は残さない。
    await page.route((url) => url.pathname === secondUrl, (route) => route.fulfill({
      status: 404, json: { error: { code: "NOT_FOUND", message: "質問が見つかりません。" } },
    }));
    await page.getByRole("button", { name: first.title, exact: true }).click();
    await expect(page.getByRole("heading", { name: first.title })).toBeVisible();
    await page.getByRole("button", { name: second.title, exact: true }).click();
    await expect(page.getByRole("region", { name: "生徒画面" }).getByRole("alert")).toContainText("質問が見つかりません。");
    await expect(page.getByText(second.messages[0].text)).toBeHidden();
  } finally {
    sendGate.resolve();
    readGate.resolve();
  }
});
