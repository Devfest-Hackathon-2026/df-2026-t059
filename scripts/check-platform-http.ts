// 起動中のアプリを通して、C の共通の入口（requireStudentActor / requireTeacherActor / ?view=student）の HTTP 契約を確かめる。
// Firestore・Auth Emulator と AI_MODE=fixture を使う。検証データは終了時に削除する。
//   BASE_URL=http://127.0.0.1:3000 node --conditions=react-server scripts/check-platform-http.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { deleteApp, getApps } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import type { MessageDTO } from "../src/domain/course-workflow.ts";
import { fixtureAiWorkflow } from "../src/server/ai/workflow.ts";
import { buildCourseActor } from "../src/server/auth/course-actor.ts";
import { getFirestoreAdmin } from "../src/server/firestore/admin.ts";
import { workflowStore as store } from "../src/server/firestore/workflow.ts";
import { runAiTurn, runDraftGeneration } from "../src/server/workflow/ai-steps.ts";
import { ensureUser, signIn } from "./emulator-users.ts";
import { expectNotFoundPage, expectPageRedirect } from "./expect-page.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error("Run this check against the Firestore and Auth Emulators.");
}

const base = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const origin = new URL(base).origin;
const runId = randomUUID().slice(0, 8);
const courseId = `platform-http-${runId}`;
const otherCourseId = `platform-http-other-${runId}`;
const coursesToDelete = new Set([courseId, otherCourseId]);
const db = getFirestoreAdmin();
const user = (role: string) => ({ uid: `${courseId}-${role}`, email: `${courseId}-${role}@example.com`, name: role });
const users = {
  owner: user("owner"),
  dual: user("dual"),
  outsider: user("outsider"),
  otherTeacher: user("other-teacher"),
  unverified: { ...user("unverified"), emailVerified: false },
};

async function login(uid: string) {
  const response = await fetch(`${base}/api/auth/session`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ idToken: await signIn(uid) }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  return cookie;
}

async function call(cookie: string | undefined, path: string, init: { method?: string; body?: unknown; origin?: string } = {}) {
  return fetch(`${base}/api/courses/${courseId}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { origin: init.origin ?? origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function expectStatus(response: Response, status: number, label: string) {
  const text = await response.text();
  assert.equal(response.status, status, `${label}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function check() {
  const now = Timestamp.now();
  const categories = [{ id: "vertex", name: "頂点", order: 1 }, { id: "other", name: "その他", order: 99 }];
  await db.collection("courses").doc(courseId).create({ name: "共通入口の検証", teacherEmails: [users.dual.email], categories, materials: [], createdAt: now });
  await db.collection("courses").doc(otherCourseId).create({ name: "別の講義", teacherEmails: [users.otherTeacher.email], categories, materials: [], createdAt: now });
  await Promise.all(Object.values(users).map((u) => ensureUser(u)));

  const dualActor = await buildCourseActor(users.dual, courseId);
  const invite = await store.issueInvite(dualActor, courseId);
  await store.redeemInvite(users.owner, courseId, { code: invite.code });
  await store.redeemInvite(users.dual, courseId, { code: invite.code });
  const owner = await buildCourseActor(users.owner, courseId);
  const dual = await buildCourseActor(users.dual, courseId);
  const ownerQ = await store.createQuestion(owner, courseId, { text: "本人の質問" });
  await runAiTurn(ownerQ.aiTurn, fixtureAiWorkflow);
  const dualQ = await store.createQuestion({ ...dual, teacher: false }, courseId, { text: "兼任者の質問" });
  await runAiTurn(dualQ.aiTurn, fixtureAiWorkflow);

  const cookies = {
    owner: await login(users.owner.uid),
    dual: await login(users.dual.uid),
    outsider: await login(users.outsider.uid),
    otherTeacher: await login(users.otherTeacher.uid),
  };

  const page = (path: string, cookie?: string) => fetch(`${base}${path}`, {
    redirect: "manual", headers: cookie ? { cookie } : undefined,
  });
  const dualHome = await page("/", cookies.dual);
  assert.equal(dualHome.status, 200);
  const dualHomeHtml = await dualHome.text();
  assert.ok(dualHomeHtml.includes(`href="/c/${courseId}"`));
  assert.ok(dualHomeHtml.includes(`href="/t/${courseId}"`));
  assert.ok(!dualHomeHtml.includes(otherCourseId));
  const studentHome = await page("/", cookies.owner);
  assert.equal(studentHome.status, 200);
  const studentHomeHtml = await studentHome.text();
  assert.ok(studentHomeHtml.includes(`href="/c/${courseId}"`));
  assert.ok(!studentHomeHtml.includes(`/t/${courseId}`));
  const outsiderHome = await page("/", cookies.outsider);
  assert.equal(outsiderHome.status, 200);
  assert.ok(!(await outsiderHome.text()).includes(courseId));
  const teacherHome = await page("/", cookies.otherTeacher);
  assert.equal(teacherHome.status, 200);
  const teacherHomeHtml = await teacherHome.text();
  assert.ok(teacherHomeHtml.includes(`href="/t/${otherCourseId}"`));
  assert.ok(!teacherHomeHtml.includes(`/c/${otherCourseId}`));
  const teacherPath = `/t/${courseId}?view=review`;
  const teacherLogin = `/login?next=${encodeURIComponent(teacherPath)}`;
  await expectPageRedirect(await page(teacherPath), teacherLogin);
  await expectPageRedirect(await page(teacherLogin, cookies.dual), teacherPath);
  await expectNotFoundPage(await page(teacherPath, cookies.owner));
  await expectPageRedirect(await page(`/c/${otherCourseId}`, cookies.otherTeacher), `/t/${otherCourseId}`);
  await expectPageRedirect(await page(`/c/${courseId}`, cookies.outsider), `/join/${courseId}`);
  await expectPageRedirect(await page(invite.joinPath, cookies.owner), `/c/${courseId}`);
  const invitePage = await page(invite.joinPath, cookies.outsider);
  assert.equal(invitePage.status, 200);
  assert.ok(!(await invitePage.text()).includes(invite.code));

  // 未ログインは 401
  for (const path of ["/questions", `/questions/${ownerQ.thread.id}`, "/teacher/questions?status=escalated", "/teacher/knowledge"]) {
    await expectStatus(await call(undefined, path), 401, `未ログイン ${path}`);
  }

  // 兼任者：?view=student は本人の相談だけ生徒用DTO、通常の取得は担当教員として教員用DTO
  const ownView = await expectStatus(await call(cookies.dual, `/questions/${dualQ.thread.id}?view=student`), 200, "兼任者の本人の相談");
  assert.equal("student" in ownView.data, false);
  assert.ok(ownView.data.actions && "canResolve" in ownView.data.actions);
  await expectStatus(await call(cookies.dual, `/questions/${ownerQ.thread.id}?view=student`), 404, "兼任者の生徒モードで他人の相談");
  const teacherView = await expectStatus(await call(cookies.dual, `/questions/${ownerQ.thread.id}`), 200, "兼任者の教員モードで他人の相談");
  assert.equal(teacherView.data.student.displayName, "owner");
  const ownList = await expectStatus(await call(cookies.dual, "/questions"), 200, "兼任者の自分の一覧");
  assert.deepEqual(ownList.data.map((t: { id: string }) => t.id), [dualQ.thread.id]);
  await expectStatus(await call(cookies.dual, "/teacher/questions?status=escalated"), 200, "兼任者の教員用一覧");
  await expectStatus(await call(cookies.dual, "/teacher/knowledge"), 200, "兼任者の共有済みQ&A");

  // 生徒・未参加・別講義の教員：教員用 API は 404、原文は 404、未参加の投稿は 403
  await expectStatus(await call(cookies.owner, "/teacher/questions?status=escalated"), 404, "生徒の教員用一覧");
  await expectStatus(await call(cookies.owner, "/teacher/knowledge"), 404, "生徒の共有済みQ&A");
  await expectStatus(await call(cookies.owner, `/teacher/knowledge-drafts/${ownerQ.thread.id}/dismiss`, { body: {} }), 404, "生徒の見送り");
  await expectStatus(await call(cookies.otherTeacher, "/teacher/questions?status=escalated"), 404, "別講義の教員の教員用一覧");
  await expectStatus(await call(cookies.otherTeacher, `/questions/${ownerQ.thread.id}`), 404, "別講義の教員の原文");
  await expectStatus(await call(cookies.owner, `/questions/${dualQ.thread.id}?view=student`), 404, "他の生徒の原文");
  await expectStatus(await call(cookies.outsider, `/questions/${ownerQ.thread.id}?view=student`), 404, "未参加の原文");
  await expectStatus(await call(cookies.outsider, "/questions", { body: { text: "未参加の投稿" } }), 403, "未参加の投稿");
  await expectStatus(await call(cookies.outsider, "/knowledge"), 404, "未参加の公開Q&A");

  // 状態を変える要求の同一オリジン確認は、共通化した入口でも残る
  await expectStatus(await call(cookies.dual, `/teacher/questions/${ownerQ.thread.id}/reply`, { body: { text: "返信" }, origin: "https://evil.example" }), 403, "別サイトからの教員の返信");
  await expectStatus(await call(cookies.owner, "/questions", { body: { text: "別サイトから" }, origin: "https://evil.example" }), 403, "別サイトからの投稿");

  // 取り下げた Q&A は、生徒用 API の一覧・詳細・AI の参照先と教員の一覧に出ない。過去の会話の参照 ID は残る。
  const refsOf = (thread: { messages: MessageDTO[] }) => thread.messages.flatMap((m) => m.referencedKnowledgeIds ?? []);
  const sourceQ = await store.createQuestion(owner, courseId, { text: "放物線の頂点の求め方は？" });
  await runAiTurn(sourceQ.aiTurn, fixtureAiWorkflow);
  const resolved = await store.resolveQuestion(owner, courseId, sourceQ.thread.id);
  assert.ok(resolved.generation);
  assert.deepEqual(await runDraftGeneration(resolved.generation, fixtureAiWorkflow), { applied: true, ok: true });
  const draft = await store.readDraft(dual, courseId, sourceQ.thread.id);
  assert.ok(draft.selectedVersionId);
  const publishInput = {
    versionId: draft.selectedVersionId,
    question: "放物線の頂点の求め方",
    answer: "平方完成して y = a(x - p)² + q の形にすると、頂点は (p, q) です。",
    categoryId: "vertex",
  };
  await store.dismissDraft(dual, courseId, sourceQ.thread.id);
  const restorePath = `/teacher/knowledge-drafts/${sourceQ.thread.id}/restore`;
  await expectStatus(await call(cookies.owner, restorePath, { method: "POST" }), 404, "生徒の候補の復帰");
  const restored = await expectStatus(await call(cookies.dual, restorePath, { method: "POST" }), 200, "教員の候補の復帰");
  assert.equal(restored.data.questionId, sourceQ.thread.id);
  const k1 = await store.publishDraft(dual, courseId, sourceQ.thread.id, publishInput);

  const listed = await expectStatus(await call(cookies.owner, "/knowledge"), 200, "公開中の一覧");
  assert.ok(listed.data.some((k: { id: string }) => k.id === k1.id));
  const detail = await expectStatus(await call(cookies.owner, `/knowledge/${k1.id}`), 200, "公開中の詳細");
  assert.deepEqual(Object.keys(detail.data).sort(), ["answer", "categoryId", "id", "publishedAt", "question"]);
  const cited = await expectStatus(await call(cookies.owner, "/questions", { body: { text: "頂点の座標はどう求める？" } }), 201, "公開中の Q&A を根拠にした質問");
  assert.ok(refsOf(cited.data).includes(k1.id), "公開中は AI の参照先に入る（対照）");

  const unpublishPath = `/teacher/knowledge/${k1.id}/unpublish`;
  await expectStatus(await call(cookies.owner, unpublishPath, { method: "POST" }), 404, "生徒の取り下げ");
  const unpublish = await expectStatus(await call(cookies.dual, unpublishPath, { method: "POST" }), 200, "教員の取り下げ");
  assert.deepEqual(unpublish.data, { knowledgeId: k1.id, status: "unpublished", questionId: sourceQ.thread.id });
  const listedAfter = await expectStatus(await call(cookies.owner, "/knowledge"), 200, "取り下げ後の一覧");
  assert.equal(listedAfter.data.some((k: { id: string }) => k.id === k1.id), false);
  await expectStatus(await call(cookies.owner, `/knowledge/${k1.id}`), 404, "取り下げ後の詳細");
  const teacherList = await expectStatus(await call(cookies.dual, "/teacher/knowledge"), 200, "取り下げ後の教員の一覧");
  assert.equal(teacherList.data.some((k: { id: string }) => k.id === k1.id), false);
  const uncited = await expectStatus(await call(cookies.owner, "/questions", { body: { text: "頂点の座標はどう求める？" } }), 201, "取り下げ後の質問");
  assert.equal(refsOf(uncited.data).includes(k1.id), false, "取り下げ後は AI の参照先に入らない");
  const past = await expectStatus(await call(cookies.owner, `/questions/${cited.data.id}`), 200, "過去の会話");
  assert.ok(refsOf(past.data).includes(k1.id), "過去の会話の参照 ID は書き換えない");
  // 生徒用の詳細は、元候補が確認待ちに戻っても候補本文を含まない
  const sourceView = await expectStatus(await call(cookies.owner, `/questions/${sourceQ.thread.id}`), 200, "元の相談");
  assert.equal(JSON.stringify(sourceView.data).includes(publishInput.answer), false);

  const k2 = await store.publishDraft(dual, courseId, sourceQ.thread.id, publishInput);
  assert.notEqual(k2.id, k1.id);
  const relisted = await expectStatus(await call(cookies.owner, "/knowledge"), 200, "再公開後の一覧");
  assert.ok(relisted.data.some((k: { id: string }) => k.id === k2.id));
  assert.equal(relisted.data.some((k: { id: string }) => k.id === k1.id), false);
  await expectStatus(await call(cookies.owner, `/knowledge/${k1.id}`), 404, "再公開後の古い ID");

  await expectStatus(await call(cookies.outsider, "/join", { body: { code: "invalid" } }), 400, "無効な招待");
  await expectStatus(await call(cookies.outsider, "/join", { body: { code: invite.code } }), 200, "招待で初回参加");
  for (let attempt = 0; attempt < 4; attempt++) {
    await expectStatus(await call(cookies.otherTeacher, "/join", { body: { code: "invalid" } }), 400, "コード不一致");
  }
  const limited = await call(cookies.otherTeacher, "/join", { body: { code: "invalid" } });
  assert.equal(limited.headers.get("retry-after"), "600");
  assert.equal((await expectStatus(limited, 429, "参加の試行制限")).error.code, "TOO_MANY_REQUESTS");
  const joinedHome = await page("/", cookies.outsider);
  assert.equal(joinedHome.status, 200);
  assert.ok((await joinedHome.text()).includes(`href="/c/${courseId}"`));

  const createPage = "/courses/new";
  const createLogin = `/login?next=${encodeURIComponent(createPage)}`;
  await expectPageRedirect(await page(createPage), createLogin);
  await expectPageRedirect(await page(createLogin, cookies.outsider), createPage);
  const creationForm = await page(createPage, cookies.outsider);
  assert.equal(creationForm.status, 200);
  assert.match(await creationForm.text(), /講義名/);

  const courseInput = { name: "  自分で作成した講義  ", requestId: randomUUID() };
  const create = (cookie: string | undefined, input: unknown) => fetch(`${base}/api/courses`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(input),
  });
  await expectStatus(await create(undefined, courseInput), 401, "未ログインの講義作成");
  await expectStatus(await create(await login(users.unverified.uid), courseInput), 403, "未確認メールで講義作成");
  await expectStatus(await create(cookies.outsider, { ...courseInput, name: " " }), 400, "空の講義名");
  await expectStatus(await create(cookies.outsider, { ...courseInput, teacherEmails: [users.owner.email] }), 400, "担当教員の指定は拒否");

  const created = await expectStatus(await create(cookies.outsider, courseInput), 201, "受講者が新しい講義を作成");
  const newId = created.data.id;
  assert.equal(typeof newId, "string");
  coursesToDelete.add(newId);
  const retry = await expectStatus(await create(cookies.outsider, courseInput), 201, "同じ講義作成の再送");
  assert.equal(retry.data.id, newId);
  await expectStatus(await create(cookies.outsider, { ...courseInput, name: "別の名前" }), 409, "同じ作成要求で名前を変更");

  const newCourse = (await db.collection("courses").doc(newId).get()).data();
  assert.equal(newCourse?.name, courseInput.name.trim());
  assert.deepEqual(newCourse?.teacherEmails, [users.outsider.email]);
  assert.deepEqual(newCourse?.categories, [{ id: "other", name: "その他", order: 0 }]);
  const teacherAndStudent = await page("/", cookies.outsider);
  assert.equal(teacherAndStudent.status, 200);
  const homeHtml = await teacherAndStudent.text();
  assert.ok(homeHtml.includes('href="/courses/new"'));
  assert.ok(homeHtml.includes(`href="/t/${newId}"`));
  assert.ok(homeHtml.includes(`href="/c/${courseId}"`));
  const settings = await page(`/t/${newId}?view=settings`, cookies.outsider);
  assert.equal(settings.status, 200);
  const settingsHtml = await settings.text();
  assert.match(settingsHtml, /共有ID/);
  assert.match(settingsHtml, /参加URL/);
  await expectNotFoundPage(await page(`/t/${newId}`, cookies.owner));
  await expectNotFoundPage(await page(`/t/${courseId}`, cookies.outsider));
  await expectStatus(await fetch(`${base}/api/courses/${newId}/teacher/invite`, {
    method: "POST", headers: { origin, cookie: cookies.outsider },
  }), 201, "作成した講義の招待を発行");
  console.log("PASS: 講義作成、再送時の重複防止、講義単位の権限、作成者からの招待発行を確認した。");

  console.log("PASS: 共通の入口で、未ログイン 401・兼任者の生徒/教員モード・教員用 API の非教員 404・未参加の投稿 403・別サイトからの状態変更 403 を確認した。取り下げた Q&A は生徒用の一覧・詳細（404）・AI の参照先・教員の一覧から消え、過去の会話の参照 ID は残り、再公開は新しい ID になる。");
}

async function cleanup() {
  try {
    for (const id of coursesToDelete) await db.recursiveDelete(db.collection("courses").doc(id));
    await Promise.all([users.outsider, users.otherTeacher].map(({ uid }) => db.collection("inviteAttempts").doc(uid).delete()));
  } finally {
    await Promise.all(getApps().map(deleteApp));
  }
}

check()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(cleanup);
