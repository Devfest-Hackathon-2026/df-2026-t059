import { expect, type APIRequestContext, type Page, test } from "@playwright/test";

async function createPasswordAccount(request: APIRequestContext) {
  const email = `reviewer-${crypto.randomUUID()}@example.test`;
  const password = crypto.randomUUID();
  const response = await request.post(
    "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key",
    { data: { email, password, returnSecureToken: true } },
  );
  expect(response.ok()).toBe(true);
  return { email, password };
}

const emailButton = (page: Page) => page.getByRole("button", { name: "メールでログイン" });
const googleButton = (page: Page) => page.getByRole("button", { name: "Google でログイン" });
const cancelButton = (page: Page) => page.getByRole("button", { name: "Google ログインをキャンセル" });

async function openGooglePopup(page: Page) {
  const opened = page.waitForEvent("popup");
  await googleButton(page).click();
  const popup = await opened;
  await expect(popup.getByText("Add new account", { exact: true })).toBeVisible();
  return popup;
}

test("登録済みのメールでログインし、再読み込み後も講義一覧を表示する", async ({ page, request }) => {
  const { email, password } = await createPasswordAccount(request);
  await page.goto("/login");
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(`${password}-wrong`);
  await emailButton(page).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("メールアドレスまたはパスワードを確認してください。");
  await expect(emailButton(page)).toBeEnabled();

  await page.getByLabel("パスワード").fill(password);
  await emailButton(page).click();
  const courses = page.getByRole("heading", { name: "講義一覧" });
  await expect(courses).toBeVisible();
  await page.reload();
  await expect(courses).toBeVisible();
  await page.getByRole("button", { name: "ログアウト", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("Google ポップアップを閉じると元の画面から再試行できる", async ({ page }) => {
  await page.goto("/login");
  const popup = await openGooglePopup(page);
  await expect(cancelButton(page)).toBeEnabled();
  await popup.close();
  await expect(googleButton(page)).toBeEnabled({ timeout: 20_000 });
  await expect(emailButton(page)).toBeEnabled();
  await expect(cancelButton(page)).toBeHidden();
  const retry = await openGooglePopup(page);
  await retry.close();
});

test("招待ページで Google をキャンセルしてもメールでログインできる", async ({ page, request }) => {
  const { email, password } = await createPasswordAccount(request);
  let sessionRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/auth/session") sessionRequests += 1;
  });

  await page.goto("/join/reviewer-course");
  const popup = await openGooglePopup(page);
  await cancelButton(page).click();
  await expect(emailButton(page)).toBeEnabled();

  // キャンセル後に古いポップアップで認証が完了してもセッションを作らない。
  await popup.getByText("Add new account", { exact: true }).click();
  await popup.getByLabel(/email/i).fill(`late-popup-${crypto.randomUUID()}@example.test`);
  const closed = popup.waitForEvent("close");
  await popup.getByRole("button", { name: /sign in/i }).click();
  await closed;

  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await emailButton(page).click();
  await expect(page.getByLabel("参加コード")).toBeVisible();
  expect(sessionRequests).toBe(1);
});
