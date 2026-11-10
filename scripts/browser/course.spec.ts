import { devices, expect, type Page, test } from "@playwright/test";

async function signIn(page: Page, label: string) {
  const opened = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Google でログイン" }).click();
  const popup = await opened;
  await popup.getByText("Add new account", { exact: true }).click();
  await popup.getByLabel(/display name/i).fill(label);
  await popup.getByLabel(/email/i).fill(`${label}-${crypto.randomUUID()}@example.test`);
  const closed = popup.waitForEvent("close");
  await popup.getByRole("button", { name: /sign in/i }).click();
  await closed;
}

const studentMenu = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "生徒メニュー" }).getByRole("button", { name, exact: true });

const teacherMenu = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "先生メニュー" }).getByRole("button", { name });

test("講義作成 → スマホで参加 → AI回答・教員返信 → 共有と取り下げ", async ({ page: teacher, browser, baseURL }) => {
  const mobile = await browser.newContext({ ...devices["Pixel 7"], baseURL });
  try {
    const student = await mobile.newPage();
    await teacher.goto("/");
    await expect(teacher).toHaveURL(/\/login$/);
    await signIn(teacher, "teacher");
    await expect(teacher.getByRole("heading", { name: "講義一覧" })).toBeVisible();
    await expect(teacher.getByText(/講義がまだありません/)).toBeVisible();
    await teacher.getByRole("link", { name: "講義を作成" }).click();
    await expect(teacher.getByRole("button", { name: "講義を作成する" })).toBeDisabled();
    await teacher.getByLabel("講義名").fill("ブラウザ検証 数学Ⅰ");
    await teacher.getByRole("button", { name: "講義を作成する" }).click();
    await expect(teacher).toHaveURL(/\/t\/[a-z\d-]+$/i);
    await expect(teacher.getByRole("heading", { name: "質問対応" })).toBeVisible();
    await teacherMenu(teacher, "講義の設定").click();
    await teacher.getByRole("button", { name: "参加コードを発行", exact: true }).click();
    const code = teacher.getByRole("textbox", { name: /^参加コード/ });
    await expect(code).toHaveValue(/[A-Z0-9-]{8,}/);
    const courseId = new URL(teacher.url()).pathname.split("/").at(-1);

    await student.goto(`/join/${courseId}`);
    await expect(student.getByRole("button", { name: "Google でログイン" })).toBeVisible();
    await expect(student.getByLabel("参加コード")).toBeHidden();
    await signIn(student, "student");
    await expect(student).toHaveURL(new RegExp(`/join/${courseId}$`));
    await student.getByLabel("参加コード").fill("ZZZZ-ZZZZ");
    await student.getByRole("button", { name: "講義に参加する" }).click();
    await expect(student.getByRole("main").getByRole("alert")).toBeVisible();
    await student.getByLabel("参加コード").fill(await code.inputValue());
    await student.getByRole("button", { name: "講義に参加する" }).click();
    await expect(student).toHaveURL(new RegExp(`/c/${courseId}$`));
    await expect(student.getByRole("heading", { name: "新しい質問" })).toBeVisible();
    expect(await student.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

    const composer = student.getByPlaceholder("質問を書いてみる");
    const send = student.getByRole("button", { name: "送信", exact: true });
    await expect(send).toBeDisabled();
    await composer.fill("　 ");
    await expect(send).toBeDisabled();
    await expect(composer).toHaveAttribute("maxlength", "2000");
    const question = "平方完成で頂点を求めるには？";
    await composer.fill(question);
    const questionPath = `**/api/courses/${courseId}/questions`;
    let releases = () => {};
    const blocked = new Promise<void>((resolve) => { releases = resolve; });
    let submissions = 0;
    await student.route(questionPath, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      submissions += 1;
      await blocked;
      return route.continue();
    });
    try {
      await send.dblclick();
      await expect(send).toBeDisabled();
      await expect.poll(() => submissions).toBe(1);
    } finally {
      releases();
    }
    await expect(student).toHaveURL(/\?question=/);
    expect(submissions).toBe(1);
    const threadUrl = student.url();
    await expect(student.getByText(/二次関数.*を平方完成して/)).toBeVisible();
    await student.unroute(questionPath);
    const studentThread = await student.request.get(threadUrl.replace(`/c/${courseId}?question=`, `/api/courses/${courseId}/questions/`));
    expect(studentThread.ok()).toBeTruthy();
    const thread = (await studentThread.json()).data;
    expect(thread.messages.filter(({ role }: { role: string }) => role === "student")).toHaveLength(1);
    await student.reload();
    await expect(student.getByText(question, { exact: true }).last()).toBeVisible();

    await student.getByRole("button", { name: /先生に相談/ }).click();
    await expect(student.getByText(/先生の回答を待っています/)).toBeVisible();
    await teacherMenu(teacher, "質問対応").click();
    await teacher.getByRole("button", { name: new RegExp(question.slice(0, -1)) }).click();
    const reply = "軸は x = 2 です。まず $y=(x-2)^2+1$ の形にしましょう。";
    await teacher.getByLabel("先生の回答", { exact: true }).fill(reply);
    await teacher.getByRole("button", { name: "回答を送る" }).click();
    await expect(teacher.getByText("回答を送信しました。")).toBeVisible();
    await teacher.getByRole("dialog").getByRole("button", { name: "閉じる" }).click();

    const notification = student.getByRole("button", { name: /通知、未読1件/ });
    await expect(notification).toBeVisible({ timeout: 25_000 });
    await notification.click();
    await student.getByRole("dialog").getByRole("button", { name: /先生から回答が届きました/ }).click();
    await expect(student.getByText(/軸は x = 2 です/)).toBeVisible();
    await expect(student.getByRole("button", { name: "通知", exact: true })).toBeVisible();
    await student.getByRole("button", { name: "解決した" }).click();
    await teacherMenu(teacher, "Q&A確認").click();
    await teacher.getByRole("region", { name: "共有候補" }).getByRole("button", { name: /平方完成/ }).click();
    const draft = teacher.getByRole("dialog");
    const sharedTitle = "平方完成で軸を求める手順";
    await draft.getByLabel("タイトル").fill(sharedTitle);
    await draft.getByRole("button", { name: "編集を保存" }).click();
    await expect(draft.getByRole("button", { name: "編集を保存" })).toBeDisabled();
    await draft.getByRole("button", { name: "共有する", exact: true }).click();
    await expect(draft).toBeHidden();

    await student.getByRole("button", { name: "メニューを開く" }).click();
    await studentMenu(student, "みんなのQ&A").click();
    await expect(student.getByRole("heading", { name: "みんなのQ&A" })).toBeVisible();
    const shared = student.getByText(sharedTitle, { exact: true });
    await shared.click();
    await expect(student.locator(".shared-answer .katex").first()).toBeVisible();
    await student.goBack();
    await expect(student).toHaveURL(threadUrl);
    await student.goForward();
    await expect(shared).toBeVisible();

    await teacherMenu(teacher, "共有済みQ&A").click();
    const published = teacher.getByRole("region", { name: "共有済みQ&A" });
    await published.getByText(sharedTitle, { exact: true }).click();
    await published.getByRole("button", { name: /取り下げ/ }).click();
    await published.getByRole("button", { name: "取り下げる", exact: true }).click();
    await expect(published.getByText(sharedTitle)).toBeHidden();
    await student.reload();
    await expect(student.getByText("該当するQ&Aが見つかりませんでした。")).toBeVisible();

    await student.goto("/");
    await expect(student.getByRole("link", { name: /ブラウザ検証.*生徒画面/ })).toBeVisible();
    await student.getByRole("button", { name: "ログアウト", exact: true }).click();
    await expect(student).toHaveURL(/\/login$/);
    await student.goto(threadUrl);
    await expect(student).toHaveURL(/\/login\?next=/);
  } finally {
    await mobile.close();
  }
});
