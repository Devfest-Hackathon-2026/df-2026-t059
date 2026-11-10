// 起動中のアプリを通して B の教員用APIのうち、AIで共有候補を作る操作と入口の権限を確認する。
// Firestore・Auth Emulator と AI_MODE=fixture（既定）を使い、検証データは終了時に削除する。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { deleteApp, getApps } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import type { ApiSuccess, KnowledgeDraftDTO, StudentThreadDetailDTO, TeacherThreadDetailDTO } from "../src/domain/course-workflow.ts";
import { fixtureAiWorkflow } from "../src/server/ai/workflow.ts";
import { buildCourseActor } from "../src/server/auth/course-actor.ts";
import { getAuthAdmin, getFirestoreAdmin } from "../src/server/firestore/admin.ts";
import { workflowStore } from "../src/server/firestore/workflow.ts";
import { runAiTurn } from "../src/server/workflow/ai-steps.ts";
import { ensureUser, signIn } from "./emulator-users.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error("Run this check against the Firestore and Auth Emulators.");
}

const base = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const origin = new URL(base).origin;
const courseId = `teacher-http-${randomUUID().slice(0, 8)}`;
const path = `/api/courses/${courseId}`;
const db = getFirestoreAdmin();
// student：参加済みの生徒だけ／teacher：担当教員だけ／dual：参加済みで担当教員も兼ねる
const users = ["student", "teacher", "dual"].map((role) => ({
  uid: `${courseId}-${role}`, email: `${courseId}-${role}@example.com`, name: role,
}));
const [student, teacher, dual] = users;

async function call(cookie: string | undefined, suffix: string, body?: unknown) {
  return fetch(`${base}${path}${suffix}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin, ...(cookie ? { cookie } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function data<T>(response: Response, status = 200): Promise<T> {
  const payload = await response.json() as ApiSuccess<T>;
  assert.equal(response.status, status, JSON.stringify(payload));
  return payload.data;
}

async function login(uid: string) {
  const response = await fetch(`${base}/api/auth/session`, {
    method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ idToken: await signIn(uid) }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  return cookie;
}

/** 生徒の相談を作り、固定AIで回答させてから先生に回す。 */
async function escalatedQuestion(uid: typeof student, text: string) {
  const actor = await buildCourseActor(uid, courseId);
  const created = await workflowStore.createQuestion({ ...actor, teacher: false }, courseId, { text });
  await runAiTurn(created.aiTurn, fixtureAiWorkflow);
  await workflowStore.escalateQuestion({ ...actor, teacher: false }, courseId, created.thread.id);
  return created.thread.id;
}

async function check() {
  await db.collection("courses").doc(courseId).create({
    name: "教員API検証", teacherEmails: [teacher.email, dual.email], materials: [], createdAt: Timestamp.now(),
    categories: [{ id: "vertex", name: "頂点", order: 1 }, { id: "other", name: "その他", order: 2 }],
  });
  await Promise.all(users.map(ensureUser));
  const invite = await workflowStore.issueInvite(await buildCourseActor(teacher, courseId), courseId);
  await workflowStore.redeemInvite(student, courseId, { code: invite.code });
  await workflowStore.redeemInvite(dual, courseId, { code: invite.code });
  const [studentCookie, teacherCookie, dualCookie] = await Promise.all(users.map(({ uid }) => login(uid)));

  const questionId = await escalatedQuestion(student, "二次関数の頂点はどう求める？");
  const draftPath = `/teacher/questions/${questionId}/draft`;

  // 入口の権限：未ログインは 401、生徒だけのアカウントは教員用APIを使えない（404）。
  assert.equal((await call(undefined, draftPath, {})).status, 401);
  for (const [suffix, body] of [
    [draftPath, {}], [draftPath, { mode: "regenerate" }], ["/teacher/questions?status=escalated", undefined],
    ["/teacher/knowledge-drafts", undefined], ["/teacher/knowledge", undefined], ["/teacher/invite", undefined],
    [`/teacher/questions/${questionId}/reply`, { text: "生徒からの返信" }],
  ] as const) assert.equal((await call(studentCookie, suffix, body)).status, 404, suffix);
  // 生徒の自分の相談でも、教員用APIからは生徒としての別案作成を通さない。
  assert.equal((await db.doc(`courses/${courseId}/knowledgeDrafts/${questionId}`).get()).exists, false);
  const crossSite = await fetch(`${base}${path}${draftPath}`, {
    method: "POST", headers: { cookie: teacherCookie, origin: "https://other.invalid", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(crossSite.status, 403);
  assert.equal((await call(teacherCookie, draftPath, { mode: "other" })).status, 400);
  assert.equal((await call(teacherCookie, "/teacher/questions/missing/draft", {})).status, 404);

  // 候補がない相談では retry できない。新規作成は教員の作成として記録し、相談は解決済みにしない。
  assert.equal((await call(teacherCookie, draftPath, { mode: "retry" })).status, 409);
  const before = await data<TeacherThreadDetailDTO>(await call(teacherCookie, `/questions/${questionId}`));
  assert.equal(before.actions.canRequestDraft, true);
  assert.equal(before.summaryStatus, "none");
  const first = await data<KnowledgeDraftDTO>(await call(teacherCookie, draftPath, {}));
  assert.equal(first.versions.length, 1);
  assert.equal(first.lastGeneration?.status, "succeeded");
  assert.equal(first.lastGeneration?.reason, "teacher_create");
  assert.equal(first.lastGeneration?.requestedBy, "teacher");
  assert.equal(first.selectedVersionId, first.versions[0].id);
  assert.equal(first.questionResolved, false);
  const after = await data<TeacherThreadDetailDTO>(await call(teacherCookie, `/questions/${questionId}`));
  assert.equal(after.resolvedAt, null);
  assert.equal(after.summaryStatus, "ready");
  assert.equal(after.actions.canReply, true);

  // 別案は版を追加し、選択中の版は変えない。
  const second = await data<KnowledgeDraftDTO>(await call(teacherCookie, draftPath, { mode: "regenerate" }));
  assert.equal(second.versions.length, 2);
  assert.equal(second.lastGeneration?.reason, "regenerate");
  assert.equal(second.selectedVersionId, first.selectedVersionId);

  // 兼任アカウント：教員用APIでは教員として扱う（自分の相談でなくても作れ、記録は teacher）。
  const dualTarget = await escalatedQuestion(student, "判別式が0のときグラフはどうなる？");
  const dualDraft = await data<KnowledgeDraftDTO>(await call(dualCookie, `/teacher/questions/${dualTarget}/draft`, {}));
  assert.equal(dualDraft.lastGeneration?.requestedBy, "teacher");
  assert.equal(dualDraft.lastGeneration?.reason, "teacher_create");
  // 兼任アカウント自身の相談でも、教員用APIからは教員として作る。生徒用APIでは引き続き本人として扱われる。
  const ownQuestion = await escalatedQuestion(dual, "平方完成のやり方は？");
  const ownDraft = await data<KnowledgeDraftDTO>(await call(dualCookie, `/teacher/questions/${ownQuestion}/draft`, {}));
  assert.equal(ownDraft.lastGeneration?.requestedBy, "teacher");
  const ownView = await data<StudentThreadDetailDTO>(await call(dualCookie, `/questions/${ownQuestion}?view=student`));
  assert.equal("student" in ownView, false);

  console.log("PASS: 教員用APIの入口の権限（生徒・兼任）と、AIでの共有候補の作成・別案・再試行の拒否を確認した。");
}

check().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try {
    await db.recursiveDelete(db.collection("courses").doc(courseId));
    await getAuthAdmin().deleteUsers(users.map(({ uid }) => uid));
  } finally {
    await Promise.all(getApps().map(deleteApp));
  }
});
