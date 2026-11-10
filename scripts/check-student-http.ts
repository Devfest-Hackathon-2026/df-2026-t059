// 起動中のアプリを通して A のAPIを確認する。Firestore・Auth Emulatorと AI_MODE=fixture を使う。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { deleteApp, getApps } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import type { ApiSuccess, PublishedKnowledgeDTO, StudentNotificationDTO, StudentThreadDetailDTO, TeacherThreadDetailDTO, ThreadSummaryDTO } from "../src/domain/course-workflow.ts";
import { AI_CONTEXT_MAX_MESSAGES, MESSAGE_MAX_LENGTH, RELATED_CONTEXT_MAX_MESSAGES } from "../src/domain/limits.ts";
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
const courseId = `student-http-${randomUUID().slice(0, 8)}`;
const path = `/api/courses/${courseId}`;
const db = getFirestoreAdmin();
const users = ["owner", "other", "teacher"].map((role) => ({
  uid: `${courseId}-${role}`, email: `${courseId}-${role}@example.com`, name: role,
}));

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

async function check() {
  const now = Timestamp.now();
  await db.collection("courses").doc(courseId).create({
    name: "生徒API検証", teacherEmails: [users[2].email], materials: [], createdAt: now,
    categories: [{ id: "vertex", name: "頂点", order: 1 }, { id: "other", name: "その他", order: 2 }],
  });
  await Promise.all(users.map(ensureUser));
  const teacher = await buildCourseActor(users[2], courseId);
  const invite = await workflowStore.issueInvite(teacher, courseId);
  await workflowStore.redeemInvite(users[0], courseId, { code: invite.code });
  await workflowStore.redeemInvite(users[1], courseId, { code: invite.code });
  const [ownerCookie, otherCookie, teacherCookie] = await Promise.all(users.map(({ uid }) => login(uid)));

  for (const [suffix, body] of [
    ["/questions", undefined], ["/questions", { text: "頂点の求め方" }], ["/knowledge", undefined],
    ["/questions/q/messages", { text: "補足" }], ["/questions/q/ai/retry", {}],
    ["/questions/q/escalate", {}], ["/questions/q/resolve", {}], ["/questions/q/summary/retry", {}],
    ["/questions/q/summary/regenerate", {}], ["/notifications", undefined], ["/notifications/n/read", {}], ["/knowledge/k", undefined],
  ] as const) assert.equal((await call(undefined, suffix, body)).status, 401);

  assert.equal((await call(teacherCookie, "/questions", { text: "未参加教員からの投稿" })).status, 403);
  assert.equal((await call(ownerCookie, "/questions", { text: " " })).status, 400);
  assert.equal((await call(ownerCookie, "/questions", { text: "あ".repeat(MESSAGE_MAX_LENGTH + 1) })).status, 400);
  const crossSite = await fetch(`${base}${path}/questions`, {
    method: "POST", headers: { cookie: ownerCookie, origin: "https://other.invalid", "content-type": "application/json" },
    body: JSON.stringify({ text: "拒否される投稿" }),
  });
  assert.equal(crossSite.status, 403);

  const created = await data<StudentThreadDetailDTO>(await call(ownerCookie, "/questions", {
    text: "二次関数の頂点はどう求める？", studentId: users[1].uid, role: "teacher",
  }), 201);
  assert.equal(created.status, "ai_answered");
  assert.equal(created.messages.length, 2);
  assert.equal(created.actions.canSendMessage, true);
  assert.equal("student" in created, false);
  const q = `/questions/${created.id}`;
  assert.equal((await call(otherCookie, `${q}?view=student`)).status, 404);
  assert.equal((await call(otherCookie, `${q}/messages`, { text: "他人の追記" })).status, 404);
  assert.equal((await data<ThreadSummaryDTO[]>(await call(otherCookie, "/questions"))).length, 0);
  assert.equal((await data<ThreadSummaryDTO[]>(await call(ownerCookie, "/questions")))[0].id, created.id);

  const continued = await data<StudentThreadDetailDTO>(await call(ownerCookie, `${q}/messages`, { text: "平方完成の途中も教えて" }));
  assert.equal(continued.messages.length, 4);
  await data(await call(ownerCookie, `${q}/escalate`, {}));
  const supplemented = await data<StudentThreadDetailDTO>(await call(ownerCookie, `${q}/messages`, { text: "この途中式の確認をお願いします" }));
  assert.equal(supplemented.status, "escalated");
  assert.equal(supplemented.messages.length, 5);
  assert.equal(supplemented.messages.at(-1)?.role, "student");
  await data<TeacherThreadDetailDTO>(await call(teacherCookie, `/teacher/questions/${created.id}/reply`, { text: "平方完成して頂点を読み取ります。" }));
  const inbox = await data<StudentNotificationDTO[]>(await call(ownerCookie, "/notifications"));
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].questionId, created.id);
  assert.equal(inbox[0].readAt, null);
  assert.equal((await data<StudentNotificationDTO[]>(await call(otherCookie, "/notifications"))).length, 0);
  assert.equal((await call(otherCookie, `/notifications/${inbox[0].id}/read`, {})).status, 404);
  const readResponses = await Promise.all([
    call(ownerCookie, `/notifications/${inbox[0].id}/read`, {}),
    call(ownerCookie, `/notifications/${inbox[0].id}/read`, {}),
  ]);
  const [read, reread] = await Promise.all(readResponses.map((response) => data<StudentNotificationDTO>(response)));
  assert.ok(read.readAt);
  assert.equal(read.readAt, reread.readAt);
  const otherDeviceCookie = await login(users[0].uid);
  assert.equal((await data<StudentNotificationDTO[]>(await call(otherDeviceCookie, "/notifications")))[0].readAt, read.readAt);
  const replied = await data<StudentThreadDetailDTO>(await call(ownerCookie, `${q}?view=student`));
  assert.equal(replied.status, "teacher_answered");
  assert.equal(replied.resolvedAt, null);
  const resolved = await data<StudentThreadDetailDTO>(await call(ownerCookie, `${q}/resolve`, {}));
  assert.ok(resolved.resolvedAt);
  assert.equal(resolved.summaryStatus, "ready");
  assert.equal("versions" in resolved, false);
  assert.equal(resolved.actions.canSendMessage, false);
  assert.equal((await call(ownerCookie, `${q}/messages`, { text: "解決後の追記" })).status, 409);
  const repeated = await data<StudentThreadDetailDTO>(await call(ownerCookie, `${q}/resolve`, {}));
  assert.equal(repeated.resolvedAt, resolved.resolvedAt);
  const draft = await workflowStore.readDraft(teacher, courseId, created.id);
  assert.equal(draft.versions.length, 1);
  assert.equal((await data<PublishedKnowledgeDTO[]>(await call(ownerCookie, "/knowledge"))).length, 0);
  const version = draft.versions[0];
  await workflowStore.publishDraft(teacher, courseId, created.id, { ...version, versionId: version.id });
  const published = await data<PublishedKnowledgeDTO[]>(await call(ownerCookie, "/knowledge"));
  assert.equal(published.length, 1);
  assert.deepEqual(Object.keys(published[0]).sort(), ["answer", "categoryId", "id", "publishedAt", "question"]);
  const reference = await data<PublishedKnowledgeDTO>(await call(ownerCookie, `/knowledge/${published[0].id}`));
  assert.deepEqual(reference, published[0]);
  assert.equal((await call(ownerCookie, `/knowledge/${created.id}`)).status, 404);
  const regenerated = await data<StudentThreadDetailDTO>(await call(ownerCookie, `${q}/summary/regenerate`, {}));
  assert.equal(regenerated.summaryStatus, "published");
  assert.equal("versions" in regenerated, false);
  const alternatives = await workflowStore.readDraft(teacher, courseId, created.id);
  assert.equal(alternatives.versions.length, draft.versions.length + 1);
  assert.equal(alternatives.selectedVersionId, draft.selectedVersionId);
  assert.deepEqual(await data<PublishedKnowledgeDTO>(await call(ownerCookie, `/knowledge/${published[0].id}`)), published[0]);

  const related = await data<StudentThreadDetailDTO>(await call(ownerCookie, "/questions", {
    text: "その座標はどう求める？", sourceQuestionId: created.id,
  }), 201);
  assert.notEqual(related.id, created.id);
  assert.equal(related.relatedQuestion?.id, created.id);
  assert.deepEqual(Object.keys(related.relatedQuestion ?? {}).sort(), ["id", "title"]);
  assert.equal(related.messages[0].text, "その座標はどう求める？");
  assert.ok(related.messages.at(-1)?.text.includes("平方完成") || related.messages.at(-1)?.text.includes("頂点"));
  assert.equal((await data<StudentThreadDetailDTO>(await call(ownerCookie, `/questions/${related.id}?view=student`))).relatedQuestion?.id, created.id);
  assert.equal((await call(otherCookie, "/questions", { text: "他人の文脈を読む", sourceQuestionId: created.id })).status, 404);

  const owner = await buildCourseActor(users[0], courseId);
  const legacy = await workflowStore.createQuestion(owner, courseId, {
    text: "鉄と不純物からなる試料300mgを希硫酸に溶かし、鉄を全て2価の陽イオンとした。この溶液に、硫酸で酸性にした0.020 mol/Lの溶液を加え、鉄の含有量を求める。",
  });
  await workflowStore.finishAiTurn(legacy.aiTurn, {
    text: "酸化還元滴定の量から鉄の質量を求めます。", referencedKnowledgeIds: [], escalate: false, reason: "",
  });
  const legacyPath = `/questions/${legacy.thread.id}`;
  const active = await data<StudentThreadDetailDTO>(await call(ownerCookie, `${legacyPath}?view=student`));
  assert.equal(active.title, "試料中の鉄の定量");
  const resolvedLegacy = await data<StudentThreadDetailDTO>(await call(ownerCookie, `${legacyPath}/resolve`, {}));
  assert.ok(resolvedLegacy.resolvedAt);
  assert.equal(resolvedLegacy.title, active.title);
  const teacherThreads = await data<ThreadSummaryDTO[]>(await call(teacherCookie, "/teacher/questions?status=ai_answered"));
  assert.equal(teacherThreads.find((thread) => thread.id === legacy.thread.id)?.title, active.title);

  const unanswered = await workflowStore.createQuestion(owner, courseId, { text: "先生の確認を待っている質問" });
  await workflowStore.finishAiTurn(unanswered.aiTurn, {
    text: "先生に引き継ぎます。", referencedKnowledgeIds: [], escalate: true, reason: "insufficient_basis",
  });
  const unansweredPath = `/questions/${unanswered.thread.id}`;
  const closed = await data<StudentThreadDetailDTO>(await call(ownerCookie, `${unansweredPath}/resolve`, {}));
  assert.ok(closed.resolvedAt);
  assert.equal(closed.sharingExcluded, true);
  assert.equal(closed.summaryStatus, "dismissed");
  assert.equal(closed.actions.canRetrySummary, false);
  assert.equal((await call(ownerCookie, `${unansweredPath}/summary/retry`, {})).status, 409);
  assert.equal((await call(teacherCookie, `/teacher${unansweredPath}/draft`, {})).status, 409);
  assert.equal((await call(teacherCookie, `/teacher/knowledge-drafts/${unanswered.thread.id}`)).status, 404);

  const failed = await workflowStore.createQuestion(owner, courseId, { text: "頂点を求める方法" });
  await workflowStore.failAiTurn(failed.aiTurn, "test_failure");
  const recovered = await data<StudentThreadDetailDTO>(await call(ownerCookie, `/questions/${failed.thread.id}/ai/retry`, {}));
  assert.equal(recovered.status, "ai_answered");
  assert.equal(recovered.messages.length, 2);
  const summary = await workflowStore.resolveQuestion(owner, courseId, failed.thread.id);
  assert.ok(summary.generation);
  await workflowStore.failDraftGeneration(summary.generation, "test_failure");
  const retried = await data<StudentThreadDetailDTO>(await call(ownerCookie, `/questions/${failed.thread.id}/summary/retry`, {}));
  assert.equal(retried.summaryStatus, "ready");
  assert.equal(retried.resolvedAt, summary.thread.resolvedAt);

  // 兼任ユーザーが生徒用APIを使っても、教員用の本文・権限へ切り替わらない。
  await workflowStore.redeemInvite(users[2], courseId, { code: invite.code });
  const ownTeacher = await data<StudentThreadDetailDTO>(await call(teacherCookie, "/questions", { text: "頂点についての質問" }), 201);
  const defaultView = await data<TeacherThreadDetailDTO>(await call(teacherCookie, `/questions/${ownTeacher.id}`));
  assert.ok("student" in defaultView);
  const studentView = await data<StudentThreadDetailDTO>(await call(teacherCookie, `/questions/${ownTeacher.id}?view=student`));
  assert.equal("student" in studentView, false);
  assert.equal(studentView.actions.canSendMessage, true);
  assert.equal((await call(teacherCookie, `/questions/${created.id}?view=student`)).status, 404);

  // pendingのまま再送しても、AI回答の重複や追加発言の保存を許可しない。
  const pending = await workflowStore.createQuestion(owner, courseId, { text: "頂点の別問題" });
  assert.equal((await call(ownerCookie, `/questions/${pending.thread.id}/messages`, { text: "連打" })).status, 409);
  await runAiTurn(pending.aiTurn, fixtureAiWorkflow);
  assert.equal((await call(ownerCookie, `/questions/${pending.thread.id}/summary/regenerate`, {})).status, 409);

  const longSource = await workflowStore.createQuestion(owner, courseId, { text: "引き継ぐ最初の質問" });
  const longSourceRef = db.collection("courses").doc(courseId).collection("questions").doc(longSource.thread.id);
  const batch = db.batch();
  for (let sequence = 2; sequence <= 25; sequence++) {
    batch.create(longSourceRef.collection("messages").doc(String(sequence).padStart(6, "0")), {
      role: sequence % 2 ? "student" : "assistant", text: `文脈${sequence}`, sequence,
      authorUid: null, referencedKnowledgeIds: [], lowConfidence: false, createdAt: Timestamp.now(),
    });
  }
  batch.update(longSourceRef, { messageCount: 25, status: "ai_answered", aiAttempt: null });
  await batch.commit();
  const child = await workflowStore.createQuestion(owner, courseId, { text: "新しい質問", sourceQuestionId: longSource.thread.id });
  const childRef = db.collection("courses").doc(courseId).collection("questions").doc(child.thread.id);
  const savedContext = (await childRef.get()).data()?.relatedQuestion.messages as unknown[];
  assert.equal(savedContext.length, RELATED_CONTEXT_MAX_MESSAGES);
  const contextBefore = await workflowStore.getAiTurnContext(child.aiTurn);
  assert.equal(contextBefore.messages[0].text, "引き継ぐ最初の質問");
  assert.equal(contextBefore.messages.at(-1)?.text, "新しい質問");
  await longSourceRef.collection("messages").doc("000001").update({ text: "元の会話が後から変わっても" });
  assert.deepEqual((await workflowStore.getAiTurnContext(child.aiTurn)).messages, contextBefore.messages);
  const childBatch = db.batch();
  for (let sequence = 2; sequence <= 25; sequence++) {
    childBatch.create(childRef.collection("messages").doc(String(sequence).padStart(6, "0")), {
      role: sequence % 2 ? "student" : "assistant", text: `続き${sequence}`, sequence,
      authorUid: null, referencedKnowledgeIds: [], lowConfidence: false, createdAt: Timestamp.now(),
    });
  }
  childBatch.update(childRef, { messageCount: 25 });
  await childBatch.commit();
  const windowed = await workflowStore.getAiTurnContext(child.aiTurn);
  assert.equal(windowed.messages.length, AI_CONTEXT_MAX_MESSAGES);
  assert.equal(windowed.messages.at(-1)?.text, "続き25");
  const longId = "q".repeat(200);
  const originalRecord = (await db.collection("courses").doc(courseId).collection("questions").doc(created.id).get()).data();
  await db.collection("courses").doc(courseId).collection("questions").doc(longId).set({
    ...originalRecord, status: "escalated", resolvedAt: null, messageCount: 0, aiAttempt: null, draft: null,
  });
  await data(await call(teacherCookie, `/teacher/questions/${longId}/reply`, { text: "長いIDの既存相談への返信" }));
  const longIdNotice = (await data<StudentNotificationDTO[]>(await call(ownerCookie, "/notifications")))
    .find((notice) => notice.questionId === longId);
  assert.ok(longIdNotice);
  assert.ok(longIdNotice.id.length <= 200);
  assert.ok((await data<StudentNotificationDTO>(await call(ownerCookie, `/notifications/${longIdNotice.id}/read`, {}))).readAt);
  console.log("PASS: 生徒APIと追加4機能の権限・通知と既読・文脈保存・別案再生成・公開Q&A詳細を確認した。");
}

check().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try {
    await db.recursiveDelete(db.collection("courses").doc(courseId));
    await getAuthAdmin().deleteUsers(users.map(({ uid }) => uid));
  } finally {
    await Promise.all(getApps().map(deleteApp));
  }
});
