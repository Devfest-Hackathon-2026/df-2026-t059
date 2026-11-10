// Firestore Emulator + Auth Emulator で、権限・状態遷移・競合を確かめる。npm run check:firestore
// Emulator を起動していない状態で実行する（emulators:exec が一時的に起動して終了時に止める）。
// 主体はこのスクリプトの中だけで作る（HTTP で役割を名乗る抜け道は作らない）。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { deleteApp, getApps } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import type {
  AiWorkflow,
  StudentThreadDetailDTO,
  TeacherThreadDetailDTO,
  ThreadDetailDTO,
} from "../src/domain/course-workflow.ts";
import { fixtureAiWorkflow } from "../src/server/ai/workflow.ts";
import { type Principal, studentView } from "../src/server/auth/access.ts";
import { buildCourseActor } from "../src/server/auth/course-actor.ts";
import { createSessionCookie, verifySessionCookie } from "../src/server/auth/session.ts";
import { isAppError } from "../src/server/errors.ts";
import { getFirestoreAdmin } from "../src/server/firestore/admin.ts";
import { workflowStore as store } from "../src/server/firestore/workflow.ts";
import {
  requestAndGenerateDraft,
  runAiTurn,
  runDraftGeneration,
  summarizeWithConfiguredAi,
} from "../src/server/workflow/ai-steps.ts";
import { ensureUser, signIn } from "./emulator-users.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error("Run this check against the Firestore and Auth Emulators.");
}

const db = getFirestoreAdmin();
const runId = randomUUID().slice(0, 8);
const courseId = `check-${runId}`;
const otherCourseId = `check-other-${runId}`;
const passed: string[] = [];

function ok(label: string) {
  passed.push(label);
  console.log(`  ✔ ${label}`);
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => isAppError(error) && error.code === code);
}

const isTeacherView = (dto: ThreadDetailDTO): dto is TeacherThreadDetailDTO => "student" in dto;

/** 固定のAI応答（D担当の固定実装の代わり。このスクリプトの中だけで使う）。 */
function fixtureAi(overrides: Partial<AiWorkflow> = {}): AiWorkflow {
  return {
    classifyQuestion: async () => ({ categoryIds: ["vertex", "not-a-category", "vertex"] }),
    answerQuestion: async () => ({ text: "平方完成すると頂点が分かります。", referencedKnowledgeIds: [], escalate: false, reason: "" }),
    summarizeConversation: async ({ messages }) => ({
      question: "二次関数の頂点の求め方",
      answer: `平方完成して y=a(x-p)^2+q の形にすると頂点は (p, q)。（会話${messages.length}件から要約）`,
    }),
    ...overrides,
  };
}

/** Auth Emulator のテストユーザーでログインし、セッション Cookie を経由して主体を作る（本番と同じ経路）。 */
async function login(uid: string, email: string, name: string | null): Promise<Principal> {
  await ensureUser({ uid, email, name });
  const session = await createSessionCookie(await signIn(uid));
  const principal = await verifySessionCookie(session.value);
  assert.ok(principal, "session cookie should verify");
  return principal;
}

async function check() {
  const now = Timestamp.now();
  const categories = [
    { id: "vertex", name: "頂点と軸", order: 1 },
    { id: "discriminant", name: "判別式", order: 2 },
    { id: "other", name: "その他", order: 99 },
  ];
  await db.collection("courses").doc(courseId).create({
    name: "検証用の講義", teacherEmails: ["teacher@example.com"], categories, materials: [], createdAt: now,
  });
  await db.collection("courses").doc(otherCourseId).create({
    name: "別の講義", teacherEmails: ["other-teacher@example.com"], categories, materials: [], createdAt: now,
  });

  const ownerP = await login(`owner-${runId}`, "owner@example.com", "生徒 太郎");
  const otherP = await login(`other-${runId}`, "other@example.com", "生徒 花子");
  const noNameP = await login(`noname-${runId}`, "noname@example.com", null);
  const outsiderP = await login(`outsider-${runId}`, "outsider@example.com", "未参加");
  const teacherP = await login(`teacher-${runId}`, "Teacher@Example.com", "先生");
  const otherTeacherP = await login(`other-teacher-${runId}`, "other-teacher@example.com", "別講義の先生");

  // --- 未認証 ---
  assert.equal(await verifySessionCookie(undefined), null);
  ok("未認証（Cookie なし・不正な Cookie）は主体にならない");

  // --- 招待と参加 ---
  const teacher = await buildCourseActor(teacherP, courseId);
  assert.equal(teacher.teacher, true);
  assert.equal(teacher.enrolled, false);
  const otherTeacherHere = await buildCourseActor(otherTeacherP, courseId);
  assert.equal(otherTeacherHere.teacher, false);
  ok("担当教員は teacherEmails と検証済みメールで判定（大文字小文字は区別しない）。別講義の教員はこの講義の教員ではない");

  await rejectsWith(store.issueInvite(await buildCourseActor(outsiderP, courseId), courseId), "NOT_FOUND");
  const invite = await store.issueInvite(teacher, courseId);
  assert.match(invite.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(invite.joinPath, `/join/${courseId}`);
  assert.equal(Date.parse(invite.expiresAt) - Date.parse(invite.issuedAt), 30 * 60 * 1000);
  const stored = await db.collection("courses").doc(courseId).collection("invites").get();
  assert.ok(!JSON.stringify(stored.docs.map((d) => [d.id, d.data()])).includes(invite.code.replace("-", "")));
  ok("招待は担当教員だけが発行できる。DB に生のコードは残らない");

  await rejectsWith(store.redeemInvite(ownerP, courseId, { code: "invalid" }), "INVALID_INPUT");
  await rejectsWith(store.redeemInvite(ownerP, "no-such-course", { code: invite.code }), "INVALID_INPUT");
  const outsider = await buildCourseActor(outsiderP, courseId);
  assert.equal(outsider.enrolled, false);
  await rejectsWith(store.createQuestion(outsider, courseId, { text: "質問" }), "FORBIDDEN");
  await rejectsWith(store.listPublishedKnowledge(outsider, courseId), "NOT_FOUND");
  await rejectsWith(store.getCourseView(outsider, courseId), "NOT_FOUND");
  ok("ログインしただけ・誤ったコードでは参加にならず、未参加は投稿・公開Q&A・講義情報を使えない");

  assert.deepEqual(await store.redeemInvite(ownerP, courseId, { code: invite.code.toLowerCase() }), {
    enrolled: true, alreadyEnrolled: false,
  });
  assert.deepEqual(await store.redeemInvite(ownerP, courseId, { code: "" }), { enrolled: true, alreadyEnrolled: true });
  await store.redeemInvite(otherP, courseId, { code: invite.code.replace("-", "") });
  const reissued = await store.issueInvite(teacher, courseId);
  assert.equal(reissued.joinPath, invite.joinPath);
  await rejectsWith(store.redeemInvite(noNameP, courseId, { code: invite.code }), "INVALID_INPUT");
  await store.redeemInvite(noNameP, courseId, { code: reissued.code });
  assert.equal((await buildCourseActor(ownerP, courseId)).enrolled, true);
  assert.deepEqual(await store.getInviteStatus(teacher, courseId), {
    active: true, issuedAt: reissued.issuedAt, expiresAt: reissued.expiresAt,
  });
  ok("再発行で旧コードは失効する。参加URLは固定で、参加済みの生徒は継続できる");

  const activeInviteDoc = db.collection("courses").doc(courseId).collection("invites").doc(
    (await db.collection("courses").doc(courseId).collection("invites").where("active", "==", true).get()).docs[0].id,
  );
  for (const expiresAt of [Timestamp.fromMillis(Date.now() - 1000), null]) {
    await activeInviteDoc.update({ expiresAt });
    await rejectsWith(store.redeemInvite(outsiderP, courseId, { code: reissued.code }), "INVALID_INPUT");
    assert.equal((await store.getInviteStatus(teacher, courseId)).active, false);
  }
  ok("参加コードは期限後に使えない。期限なしの旧コードも失効する");

  const currentInvite = await store.issueInvite(teacher, courseId);
  const limited = await login(`limited-${runId}`, "limited@example.com", null);
  const guesses = await Promise.allSettled(Array.from({ length: 5 }, () =>
    store.redeemInvite(limited, courseId, { code: "invalid" }),
  ));
  const errors = guesses.map((guess) => {
    assert.equal(guess.status, "rejected");
    assert.ok(isAppError(guess.reason));
    return guess.reason.code;
  });
  assert.deepEqual(errors.sort(), ["INVALID_INPUT", "INVALID_INPUT", "INVALID_INPUT", "INVALID_INPUT", "TOO_MANY_REQUESTS"]);
  await rejectsWith(store.redeemInvite(limited, courseId, { code: currentInvite.code }), "TOO_MANY_REQUESTS");
  await rejectsWith(store.redeemInvite(limited, otherCourseId, { code: "invalid" }), "TOO_MANY_REQUESTS");
  const unlimited = await login(`unlimited-${runId}`, "unlimited@example.com", null);
  await store.redeemInvite(unlimited, courseId, { code: currentInvite.code });
  await db.collection("inviteAttempts").doc(limited.uid).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
  await store.redeemInvite(limited, courseId, { code: currentInvite.code });
  ok("同時送信でも5回目で制限される。他のアカウントは参加でき、制限の期限後は再試行できる");

  const owner = await buildCourseActor(ownerP, courseId);
  const other = await buildCourseActor(otherP, courseId);
  const noName = await buildCourseActor(noNameP, courseId);
  const otherTeacher = await buildCourseActor(otherTeacherP, otherCourseId);

  // --- 質問の投稿と AI 回答 ---
  await rejectsWith(store.createQuestion(owner, courseId, { text: "   " }), "INVALID_INPUT");
  await rejectsWith(store.createQuestion(owner, courseId, { text: "あ".repeat(2001) }), "INVALID_INPUT");
  const created = await store.createQuestion(owner, courseId, { text: "  二次関数の頂点はどう求める？  " });
  const qid = created.thread.id;
  assert.equal(created.thread.status, "pending");
  assert.equal(created.thread.title, "二次関数の頂点はどう求める？");
  assert.equal(created.thread.actions.canSendMessage, false);
  const firstTurn = await runAiTurn(created.aiTurn, fixtureAi({
    classifyQuestion: async () => ({ categoryIds: ["vertex", "not-a-category", "vertex"], title: "$y=x^2$ の頂点" }),
  }));
  assert.deepEqual(firstTurn, { applied: true, ok: true });
  assert.deepEqual(await store.finishAiTurn(created.aiTurn, { text: "古い応答", referencedKnowledgeIds: [], escalate: false, reason: "" }), { applied: false });
  let ownView = await store.readThread(owner, courseId, qid);
  assert.equal(ownView.status, "ai_answered");
  assert.equal(ownView.title, "$y=x^2$ の頂点");
  assert.deepEqual(ownView.categoryIds, ["vertex"]);
  assert.equal(ownView.messages.length, 2);
  assert.ok(!isTeacherView(ownView));
  ok("投稿→初回分類（許可外IDを除外）→回答を保存。同じ試行の古い応答は二重に保存しない");

  // --- AI 回答の期限切れ（90秒を過ぎた結果は保存しない）---
  const slow = await store.createQuestion(owner, courseId, { text: "放物線の向きの見分け方は？" });
  const slowRef = db.collection("courses").doc(courseId).collection("questions").doc(slow.thread.id);
  await slowRef.update({ "aiAttempt.expiresAt": Timestamp.fromMillis(Date.now() - 1000) });
  let slowView = await store.readThread(owner, courseId, slow.thread.id) as StudentThreadDetailDTO;
  assert.equal(slowView.status, "error");
  assert.equal(slowView.actions.canRetryAi, true);
  assert.equal(slowView.actions.canSendMessage, true);
  const slowTeacherView = await store.readThread(teacher, courseId, slow.thread.id);
  assert.ok(isTeacherView(slowTeacherView));
  assert.equal(slowTeacherView.status, "error");
  assert.deepEqual(slowTeacherView.actions, { canReply: false, canRequestDraft: true });
  await rejectsWith(store.getAiTurnContext(slow.aiTurn), "CONFLICT");
  assert.deepEqual(
    await store.finishAiTurn(slow.aiTurn, { text: "遅れた回答", referencedKnowledgeIds: [], escalate: false, reason: "" }),
    { applied: false },
  );
  const slowStored = (await slowRef.get()).data();
  assert.equal(slowStored?.status, "error");
  assert.equal(slowStored?.aiAttempt, null);
  assert.equal(slowStored?.lastErrorCode, "ai_timeout");
  slowView = await store.readThread(owner, courseId, slow.thread.id) as StudentThreadDetailDTO;
  assert.deepEqual(slowView.messages.map((m) => m.role), ["student"]);
  const slowRetry = await store.retryAiTurn(owner, courseId, slow.thread.id);
  assert.deepEqual(await runAiTurn(slowRetry.aiTurn, fixtureAi()), { applied: true, ok: true });
  slowView = await store.readThread(owner, courseId, slow.thread.id) as StudentThreadDetailDTO;
  assert.equal(slowView.status, "ai_answered");
  assert.deepEqual(slowView.messages.map((m) => m.role), ["student", "assistant"]);
  ok("AI 回答が期限切れなら表示は error・再試行可能（教員の候補作成ボタンも有効）。期限後に届いた回答は保存せず、生徒の発言は残る。再試行で回答できる");

  // --- 原文の閲覧範囲 ---
  await rejectsWith(store.readThread(other, courseId, qid), "NOT_FOUND");
  await rejectsWith(store.readThread(outsider, courseId, qid), "NOT_FOUND");
  await rejectsWith(store.readThread(otherTeacher, courseId, qid), "NOT_FOUND");
  await rejectsWith(store.readThread(owner, courseId, "no-such-question"), "NOT_FOUND");
  const teacherView = await store.readThread(teacher, courseId, qid);
  assert.ok(isTeacherView(teacherView));
  assert.equal(teacherView.student.displayName, "生徒 太郎");
  assert.ok(!JSON.stringify(ownView).includes("生徒 太郎"));
  ok("原文は本人と担当教員だけ。他の生徒・未参加・別講義の教員・存在しない相談はすべて 404");
  ok("本人表示（作成時のGoogle表示名）は担当教員の DTO だけに入る");

  const fromOtherDevice = await buildCourseActor(await verifySessionCookie(
    (await createSessionCookie(await signIn(ownerP.uid))).value,
  ) as Principal, courseId);
  assert.deepEqual((await store.listOwnThreads(fromOtherDevice, courseId)).map((t) => t.id).sort(), [qid, slow.thread.id].sort());
  assert.deepEqual(await store.listOwnThreads(other, courseId), []);
  ok("別端末（新しいセッション）でも同じアカウントなら参加状態と自分の相談を引き継ぐ。他人の相談は一覧に出ない");

  const noNameQ = await store.createQuestion(noName, courseId, { text: "判別式って何？" });
  await runAiTurn(noNameQ.aiTurn, fixtureAi({ classifyQuestion: async () => ({ categoryIds: [] }) }));
  const noNameTeacherView = await store.readThread(teacher, courseId, noNameQ.thread.id);
  assert.ok(isTeacherView(noNameTeacherView));
  assert.equal(noNameTeacherView.student.displayName, "noname@example.com");
  assert.deepEqual(noNameTeacherView.categoryIds, ["other"]);
  ok("表示名がなければ検証済みメールを代替表示。分類が空なら other を補完");

  // --- 連打・対応待ち・同時返信 ---
  const sends = await Promise.allSettled([
    store.addStudentMessage(owner, courseId, qid, { text: "y=x^2-4x+3 だと？" }),
    store.addStudentMessage(owner, courseId, qid, { text: "y=x^2-4x+3 だと？" }),
  ]);
  assert.equal(sends.filter((r) => r.status === "fulfilled").length, 1);
  const sent = sends.find((r) => r.status === "fulfilled");
  assert.ok(sent && sent.status === "fulfilled" && sent.value.aiTurn);
  await runAiTurn(sent.value.aiTurn, fixtureAi({
    answerQuestion: async () => ({ text: "この条件だけでは決まりません。", referencedKnowledgeIds: [], escalate: true, reason: "条件不足" }),
  }));
  ownView = await store.readThread(owner, courseId, qid);
  assert.equal(ownView.status, "escalated");
  assert.equal(ownView.escalatedBy, "ai");
  assert.equal(ownView.messages.length, 4);
  ok("連打した追加発言は1件だけ保存。AI が自信なしなら対応待ちへ");

  const supplement = await store.addStudentMessage(owner, courseId, qid, { text: "補足：教科書p.42の例題です" });
  assert.equal(supplement.aiTurn, null);
  assert.equal(supplement.thread.status, "escalated");
  ok("対応待ちの間も生徒は補足を追記できる（AI は呼ばず escalated のまま）");

  await rejectsWith(store.replyToQuestion(owner, courseId, qid, { text: "なりすまし" }), "NOT_FOUND");
  const replies = await Promise.allSettled([
    store.replyToQuestion(teacher, courseId, qid, { text: "頂点は(2,-1)です。" }),
    store.replyToQuestion(teacher, courseId, qid, { text: "頂点は(2,-1)です。" }),
  ]);
  assert.equal(replies.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = replies.find((r) => r.status === "rejected");
  assert.ok(rejected && isAppError(rejected.reason) && rejected.reason.code === "CONFLICT");
  ownView = await store.readThread(owner, courseId, qid);
  assert.equal(ownView.status, "teacher_answered");
  assert.equal(ownView.messages.filter((m) => m.role === "teacher").length, 1);
  assert.equal(ownView.resolvedAt, null);
  ok("同時返信は片方だけ保存（もう一方は 409）。先生の返信で解決済みにはならない");
  assert.deepEqual((await store.listTeacherThreads(teacher, courseId, "teacher_answered")).map((t) => t.id), [qid]);
  await rejectsWith(store.listTeacherThreads(owner, courseId, "escalated"), "NOT_FOUND");
  ok("教員の一覧は担当教員だけ");

  // --- 教員の候補作成（未解決のまま）と生成中の制約 ---
  const teacherGen = await store.requestDraftGeneration(teacher, courseId, qid);
  assert.ok(teacherGen.generation.messages.every((m) => m.text !== "この条件だけでは決まりません。"));
  ownView = await store.readThread(owner, courseId, qid) as StudentThreadDetailDTO;
  assert.equal(ownView.resolvedAt, null);
  assert.equal(ownView.summaryStatus, "generating");
  assert.equal((ownView as StudentThreadDetailDTO).actions.canResolve, false);
  await rejectsWith(store.resolveQuestion(owner, courseId, qid), "CONFLICT");
  await rejectsWith(store.requestDraftGeneration(owner, courseId, qid), "CONFLICT");
  await rejectsWith(store.requestDraftGeneration(teacher, courseId, qid), "CONFLICT");
  ok("教員は未解決の相談から候補を作れる（解決済みにしない）。生成中は解決・二重の生成を拒否");
  ok("自信のない AI 回答は要約の素材から除く");
  assert.deepEqual(await runDraftGeneration(teacherGen.generation, fixtureAi()), { applied: true, ok: true });
  let draft = await store.readDraft(teacher, courseId, qid);
  assert.equal(draft.status, "ready");
  assert.equal(draft.versions.length, 1);
  const firstVersion = draft.versions[0];
  assert.equal(draft.selectedVersionId, firstVersion.id);
  await rejectsWith(store.readDraft(owner, courseId, qid), "NOT_FOUND");
  ownView = await store.readThread(owner, courseId, qid);
  assert.ok(!JSON.stringify(ownView).includes("平方完成して"));
  assert.equal((ownView as StudentThreadDetailDTO).actions.canRequestRegeneration, true);
  ok("生成結果は最初の版として選択される。生徒には候補の本文を返さない（状態と操作可否だけ）");

  // --- 教員編集版の保護 ---
  const edited = await store.saveDraftEdit(teacher, courseId, qid, {
    baseVersionId: firstVersion.id,
    expectedSelectedVersionId: firstVersion.id,
    question: "二次関数の頂点はどう求める？",
    answer: "平方完成して頂点 (p, q) を読み取る。例：y=x^2-4x+3=(x-2)^2-1 の頂点は (2,-1)。",
    categoryId: "vertex",
  });
  const editId = edited.selectedVersionId;
  assert.ok(editId && editId !== firstVersion.id);
  await rejectsWith(store.saveDraftEdit(teacher, courseId, qid, {
    baseVersionId: firstVersion.id, expectedSelectedVersionId: firstVersion.id,
    question: "古い画面からの保存", answer: "上書きしない", categoryId: "vertex",
  }), "CONFLICT");
  await rejectsWith(store.saveDraftEdit(teacher, courseId, qid, {
    baseVersionId: editId, question: "x", answer: "y", categoryId: "unknown",
  }), "INVALID_INPUT");
  ok("教員の編集は教員編集版として保存。開いた後に別の保存があれば 409、無効なカテゴリは 400");

  // --- 生徒の解決：既存の版を残して別案を1つ ---
  const resolved = await store.resolveQuestion(owner, courseId, qid);
  assert.ok(resolved.thread.resolvedAt);
  assert.ok(resolved.generation);
  assert.equal(resolved.generation.messages.at(-1)?.role, "teacher");
  const again = await store.resolveQuestion(owner, courseId, qid);
  assert.equal(again.generation, null);
  await runDraftGeneration(resolved.generation, fixtureAi());
  draft = await store.readDraft(teacher, courseId, qid);
  assert.equal(draft.versions.length, 3);
  assert.equal(draft.selectedVersionId, editId);
  assert.equal(draft.versions.at(-1)?.kind, "generated");
  assert.equal(draft.questionResolved, true);
  ok("解決は resolvedAt と生成予約を同時に記録。既存の編集版は残り選択も変わらず、別案が1つ増える。解決の再送は何もしない");
  await rejectsWith(store.addStudentMessage(owner, courseId, qid, { text: "まだ質問" }), "CONFLICT");
  ok("解決後の追記は不可（新しい相談にする）");

  // --- 失敗と再試行、期限切れの置き換え、古い応答 ---
  const regen = await store.requestDraftGeneration(owner, courseId, qid);
  assert.deepEqual(await runDraftGeneration(regen.generation, fixtureAi({
    summarizeConversation: async () => { throw new Error("model error"); },
  })), { applied: true, ok: false });
  draft = await store.readDraft(teacher, courseId, qid);
  assert.equal(draft.versions.length, 3);
  assert.equal(draft.lastGeneration?.status, "failed");
  assert.equal(draft.status, "ready");
  ownView = await store.readThread(owner, courseId, qid) as StudentThreadDetailDTO;
  assert.equal((ownView as StudentThreadDetailDTO).actions.canRetrySummary, true);
  ok("生徒の再生成が失敗しても会話・解決日時・既存の版は残り、要約だけ再試行できる");

  const stuck = await store.requestDraftGeneration(teacher, courseId, qid, { mode: "retry" });
  const draftDoc = db.collection("courses").doc(courseId).collection("knowledgeDrafts").doc(qid);
  const active = (await draftDoc.get()).data()?.activeGeneration;
  const expired = Timestamp.fromMillis(Date.now() - 1000);
  await draftDoc.update({ "activeGeneration.expiresAt": expired });
  await db.collection("courses").doc(courseId).collection("questions").doc(qid).update({ "draft.generationExpiresAt": expired });
  const replacement = await store.requestDraftGeneration(teacher, courseId, qid);
  assert.deepEqual(await store.finishDraftGeneration(stuck.generation, { question: "遅れた応答", answer: "保存しない" }), { applied: false });
  const staleDoc = await draftDoc.collection("generations").doc(active.id).get();
  assert.equal(staleDoc.data()?.errorCode, "expired");
  await runDraftGeneration(replacement.generation, fixtureAi());
  draft = await store.readDraft(teacher, courseId, qid);
  assert.equal(draft.versions.length, 4);
  assert.ok(!draft.versions.some((v) => v.question === "遅れた応答"));
  ok("期限切れの生成は次の要求で失敗扱いにして置き換え、置き換え後に届いた古い応答は保存しない");

  // --- 公開（同時・再送・別内容）と公開データの範囲 ---
  const content = draft.versions.find((v) => v.id === editId);
  assert.ok(content);
  const publishInput = { versionId: editId, question: content.question, answer: content.answer, categoryId: content.categoryId };
  await rejectsWith(store.publishDraft(owner, courseId, qid, publishInput), "NOT_FOUND");
  const publishes = await Promise.all([
    store.publishDraft(teacher, courseId, qid, publishInput),
    store.publishDraft(teacher, courseId, qid, publishInput),
  ]);
  assert.equal(publishes[0].id, publishes[1].id);
  const knowledgeDocs = await db.collection("courses").doc(courseId).collection("knowledge").get();
  assert.equal(knowledgeDocs.size, 1);
  await rejectsWith(store.publishDraft(teacher, courseId, qid, { ...publishInput, answer: "別の内容" }), "CONFLICT");
  await rejectsWith(store.dismissDraft(teacher, courseId, qid), "CONFLICT");
  const shared = await store.listPublishedKnowledge(other, courseId);
  assert.equal(shared.length, 1);
  assert.deepEqual(Object.keys(shared[0]).sort(), ["answer", "categoryId", "id", "publishedAt", "question"]);
  const sharedJson = JSON.stringify(shared);
  for (const secret of [ownerP.uid, "生徒 太郎", "owner@example.com", qid, "補足：教科書"]) {
    assert.ok(!sharedJson.includes(secret), `public DTO must not include ${secret}`);
  }
  ok("同時の二重公開でも公開Q&Aは1件。同じ内容の再送は同じ結果、別内容は 409、公開後の見送りは 409");
  ok("公開Q&Aは id/question/answer/categoryId/publishedAt だけ（uid・表示名・メール・相談ID・原文を含まない）");

  // 再生成しても公開本文は変わらない
  const afterPublish = await store.requestDraftGeneration(teacher, courseId, qid);
  await runDraftGeneration(afterPublish.generation, fixtureAi({
    summarizeConversation: async () => ({ question: "新しい別案", answer: "公開本文には反映しない" }),
  }));
  assert.equal((await store.listPublishedKnowledge(other, courseId))[0].answer, content.answer);
  ok("公開後の再生成は別案として保存され、公開本文は自動更新されない");

  // --- 初回の要約が期限切れ（置き換え前に古い結果が届く）---
  const lateQ = await store.createQuestion(other, courseId, { text: "平方完成の途中式を見たい" });
  await runAiTurn(lateQ.aiTurn, fixtureAi());
  const lateGen = await store.requestDraftGeneration(teacher, courseId, lateQ.thread.id);
  const lateDraftDoc = db.collection("courses").doc(courseId).collection("knowledgeDrafts").doc(lateQ.thread.id);
  const pastExpiry = Timestamp.fromMillis(Date.now() - 1000);
  await lateDraftDoc.update({ "activeGeneration.expiresAt": pastExpiry });
  await db.collection("courses").doc(courseId).collection("questions").doc(lateQ.thread.id)
    .update({ "draft.generationExpiresAt": pastExpiry });
  let lateView = await store.readThread(other, courseId, lateQ.thread.id) as StudentThreadDetailDTO;
  assert.equal(lateView.summaryStatus, "failed");
  assert.equal(lateView.actions.canRetrySummary, true);
  const lateDraft = await store.readDraft(teacher, courseId, lateQ.thread.id);
  assert.equal(lateDraft.status, "failed");
  assert.equal(lateDraft.activeGeneration, null);
  assert.equal(lateDraft.lastGeneration?.status, "failed");
  assert.deepEqual(await store.finishDraftGeneration(lateGen.generation, { question: "遅れた結果", answer: "保存しない" }), { applied: false });
  assert.equal((await lateDraftDoc.collection("generations").doc(lateGen.generation.generationId).get()).data()?.errorCode, "expired");
  assert.equal((await store.readDraft(teacher, courseId, lateQ.thread.id)).versions.length, 0);
  const lateRetry = await store.requestDraftGeneration(other, courseId, lateQ.thread.id, { mode: "retry" });
  await runDraftGeneration(lateRetry.generation, fixtureAi());
  lateView = await store.readThread(other, courseId, lateQ.thread.id) as StudentThreadDetailDTO;
  assert.equal(lateView.summaryStatus, "ready");
  assert.equal(lateView.actions.canRetrySummary, false);
  ok("初回の要約が期限切れなら、表示は failed・専用の再試行が可能。期限後に届いた結果は保存せず expired として閉じる");

  // --- 見送り ---
  await rejectsWith(store.dismissDraft(teacher, courseId, noNameQ.thread.id), "NOT_FOUND");
  const nnGen = await store.requestDraftGeneration(teacher, courseId, noNameQ.thread.id);
  await runDraftGeneration(nnGen.generation, fixtureAi());
  assert.deepEqual(await store.dismissDraft(teacher, courseId, noNameQ.thread.id), { questionId: noNameQ.thread.id, status: "dismissed" });
  assert.equal((await store.listDrafts(teacher, courseId)).some((d) => d.questionId === noNameQ.thread.id), false);
  assert.equal((await store.listDrafts(teacher, courseId, { publication: ["dismissed"] })).length, 1);
  ok("見送った候補は確認待ちの一覧から外れる");

  // --- カテゴリ ---
  await rejectsWith(store.addCategory(owner, courseId, { name: "平方完成" }), "NOT_FOUND");
  const added = await store.addCategory(teacher, courseId, { name: "平方完成" });
  const newCategory = added.find((c) => c.name === "平方完成");
  assert.ok(newCategory);
  await rejectsWith(store.addCategory(teacher, courseId, { name: "平方完成" }), "CONFLICT");
  const renamed = await store.updateCategory(teacher, courseId, newCategory.id, { name: "平方完成のしかた" });
  assert.ok(renamed.some((c) => c.id === newCategory.id && c.name === "平方完成のしかた"));
  assert.ok((await store.getCourseView(owner, courseId)).categories.some((c) => c.id === newCategory.id));
  ok("カテゴリの追加・編集は担当教員だけ（同名は 409）");

  // ===== 11/8 追加：共通の主体（兼任者）=====
  const dualInvite = await store.issueInvite(teacher, courseId);
  await store.redeemInvite(teacherP, courseId, { code: dualInvite.code });
  const dual = await buildCourseActor(teacherP, courseId);
  assert.equal(dual.enrolled && dual.teacher, true);
  const dualStudent = studentView(dual);
  assert.equal(dual.teacher, true);
  const dualQ = await store.createQuestion(dualStudent, courseId, { text: "兼任者の質問：軸の求め方は？" });
  await runAiTurn(dualQ.aiTurn, fixtureAi());
  const dualOwn = await store.readThread(dualStudent, courseId, dualQ.thread.id);
  assert.ok(!isTeacherView(dualOwn));
  await rejectsWith(store.readThread(dualStudent, courseId, qid), "NOT_FOUND");
  assert.deepEqual((await store.listOwnThreads(dualStudent, courseId)).map((t) => t.id), [dualQ.thread.id]);
  await rejectsWith(store.listTeacherThreads(dualStudent, courseId, "escalated"), "NOT_FOUND");
  assert.ok(isTeacherView(await store.readThread(dual, courseId, qid)));
  assert.ok(isTeacherView(await store.readThread(dual, courseId, dualQ.thread.id)));
  await rejectsWith(store.readThread(studentView(otherTeacher), courseId, qid), "NOT_FOUND");
  // 参加していない教員の生徒用の主体は、投稿が 403（従来の未参加と同じ契約）。
  await rejectsWith(store.createQuestion(studentView(otherTeacherHere), courseId, { text: "未参加の教員" }), "FORBIDDEN");
  ok("兼任者は生徒モード（studentView）では本人の相談だけ、教員モードでは担当教員として読める。未参加・他人・別講義は従来どおり拒否");

  // ===== 11/8 追加：AI 設定エラー（getAiWorkflow() の評価から捕捉）=====
  const resolvedDual = await store.resolveQuestion(dualStudent, courseId, dualQ.thread.id);
  assert.ok(resolvedDual.generation);
  assert.deepEqual(await summarizeWithConfiguredAi(resolvedDual.generation, () => {
    throw new Error("Unsupported AI_MODE");
  }), { applied: true, ok: false });
  const dualGenId = resolvedDual.generation.generationId;
  const dualGenDoc = await db.collection("courses").doc(courseId).collection("knowledgeDrafts").doc(dualQ.thread.id)
    .collection("generations").doc(dualGenId).get();
  assert.equal(dualGenDoc.data()?.errorCode, "summary_configuration_failed");
  let dualView = await store.readThread(dualStudent, courseId, dualQ.thread.id) as StudentThreadDetailDTO;
  assert.ok(dualView.resolvedAt);
  assert.equal(dualView.summaryStatus, "failed");
  assert.equal(dualView.actions.canRetrySummary, true);
  // requestAndGenerateDraft の戻り値は applied・ok だけ。画面の状態は処理後に readThread / readDraft で取り直す
  // （予約時点の generating は完了後には古いので、成功・失敗のどちらでも返さない）。
  const dualRetry = await requestAndGenerateDraft(dualStudent, courseId, dualQ.thread.id, { mode: "retry" }, () => fixtureAi());
  assert.deepEqual(dualRetry, { applied: true, ok: true });
  dualView = await store.readThread(dualStudent, courseId, dualQ.thread.id) as StudentThreadDetailDTO;
  assert.equal(dualView.summaryStatus, "ready");
  const dualDraftOk = await store.readDraft(dual, courseId, dualQ.thread.id);
  assert.equal(dualDraftOk.status, "ready");
  assert.equal(dualDraftOk.activeGeneration, null);
  assert.equal(dualDraftOk.lastGeneration?.status, "succeeded");
  // 失敗（AI 設定エラー）でも、取り直した状態は generating ではない。既存の版があるので状態は ready のまま
  // （summaryStatusOf の既存の規則）で、失敗の再試行ができる。版がない場合の failed は上の確認のとおり。
  const dualFail = await requestAndGenerateDraft(dualStudent, courseId, dualQ.thread.id, { mode: "regenerate" }, () => {
    throw new Error("Unsupported AI_MODE");
  });
  assert.deepEqual(dualFail, { applied: true, ok: false });
  dualView = await store.readThread(dualStudent, courseId, dualQ.thread.id) as StudentThreadDetailDTO;
  assert.notEqual(dualView.summaryStatus, "generating");
  assert.equal(dualView.summaryStatus, "ready");
  assert.equal(dualView.actions.canRetrySummary, true);
  const dualDraftFail = await store.readDraft(dual, courseId, dualQ.thread.id);
  assert.equal(dualDraftFail.activeGeneration, null);
  assert.equal(dualDraftFail.lastGeneration?.status, "failed");
  assert.equal(dualDraftFail.versions.length, dualDraftOk.versions.length);
  assert.equal(dualDraftFail.selectedVersionId, dualDraftOk.selectedVersionId);
  // 失敗（AI の例外）でも同じ。
  const dualAiFail = await requestAndGenerateDraft(dualStudent, courseId, dualQ.thread.id, { mode: "retry" }, () => fixtureAi({
    summarizeConversation: async () => {
      throw new Error("model error");
    },
  }));
  assert.deepEqual(dualAiFail, { applied: true, ok: false });
  dualView = await store.readThread(dualStudent, courseId, dualQ.thread.id) as StudentThreadDetailDTO;
  assert.equal(dualView.summaryStatus, "ready");
  assert.equal(dualView.actions.canRetrySummary, true);
  assert.equal((await store.readDraft(dual, courseId, dualQ.thread.id)).lastGeneration?.status, "failed");
  // 教員の再生成（公開中の候補）の設定エラー：版・選択・公開は変わらず、取り直した状態は published。
  const qidBefore = await store.readDraft(teacher, courseId, qid);
  const qidFail = await requestAndGenerateDraft(teacher, courseId, qid, {}, () => {
    throw new Error("config");
  });
  assert.deepEqual(qidFail, { applied: true, ok: false });
  const qidAfter = await store.readDraft(teacher, courseId, qid);
  assert.equal(qidAfter.versions.length, qidBefore.versions.length);
  assert.equal(qidAfter.selectedVersionId, qidBefore.selectedVersionId);
  assert.equal(qidAfter.publication, "published");
  assert.equal(qidAfter.status, "published");
  assert.equal(qidAfter.activeGeneration, null);
  assert.equal(qidAfter.lastGeneration?.status, "failed");
  assert.equal((await store.readThread(owner, courseId, qid) as StudentThreadDetailDTO).summaryStatus, "published");
  ok("AI 設定の取得で失敗しても summary_configuration_failed を記録し、解決日時・既存の版・公開は残る。再試行で復旧できる。requestAndGenerateDraft は applied・ok だけを返し、成功・失敗とも取り直した状態は generating ではない");

  // ===== 11/8 追加：見送り → 復帰 → 公開 =====
  const nnId = noNameQ.thread.id;
  await rejectsWith(store.restoreDraft(owner, courseId, nnId), "NOT_FOUND");
  await rejectsWith(store.restoreDraft(teacher, courseId, slow.thread.id), "NOT_FOUND");
  const nnBefore = await store.readDraft(teacher, courseId, nnId);
  assert.equal(nnBefore.publication, "dismissed");
  const restores = await Promise.all([store.restoreDraft(teacher, courseId, nnId), store.restoreDraft(teacher, courseId, nnId)]);
  for (const restored of restores) {
    assert.equal(restored.status, "ready");
    assert.equal(restored.questionId, nnId);
  }
  const nnAfter = await store.readDraft(teacher, courseId, nnId);
  assert.equal(nnAfter.publication, "none");
  assert.equal(nnAfter.versions.length, nnBefore.versions.length);
  assert.equal(nnAfter.selectedVersionId, nnBefore.selectedVersionId);
  assert.ok((await store.listDrafts(teacher, courseId)).some((d) => d.questionId === nnId));
  const nnVersion = nnAfter.versions.find((v) => v.id === nnAfter.selectedVersionId);
  assert.ok(nnVersion);
  const nnPublished = await store.publishDraft(teacher, courseId, nnId, {
    versionId: nnVersion.id, question: nnVersion.question, answer: nnVersion.answer, categoryId: nnVersion.categoryId,
  });
  await rejectsWith(store.restoreDraft(teacher, courseId, nnId), "CONFLICT");
  ok("見送った候補は担当教員だけが確認待ちに戻せる（版・選択は残る、二重の要求も同じ結果）。戻した候補は公開できる。公開中・候補なしは 409/404");

  // 生成中の見送り済み候補は戻せない（完了後は戻せる）
  await store.dismissDraft(teacher, courseId, lateQ.thread.id);
  const lateRegen = await store.requestDraftGeneration(teacher, courseId, lateQ.thread.id);
  await rejectsWith(store.restoreDraft(teacher, courseId, lateQ.thread.id), "CONFLICT");
  await runDraftGeneration(lateRegen.generation, fixtureAi());
  assert.equal((await store.restoreDraft(teacher, courseId, lateQ.thread.id)).status, "ready");
  ok("生成中の見送り済み候補は戻せない（409）。生成が終われば戻せる");

  // ===== 11/8 追加：公開 → 取り下げ → 新しい ID で再公開 =====
  const k1 = publishes[0].id;
  const qidDraft = await store.readDraft(teacher, courseId, qid);
  assert.equal(qidDraft.publishedKnowledgeId, k1);
  const qidResolvedAt = (await store.readThread(owner, courseId, qid)).resolvedAt;
  await rejectsWith(store.unpublishKnowledge(owner, courseId, k1), "NOT_FOUND");
  const midGen = await store.requestDraftGeneration(teacher, courseId, qid);
  const unpublished = await store.unpublishKnowledge(teacher, courseId, k1);
  assert.deepEqual(unpublished, { knowledgeId: k1, status: "unpublished", questionId: qid });
  let qidNow = await store.readDraft(teacher, courseId, qid);
  assert.equal(qidNow.publication, "none");
  assert.equal(qidNow.publishedKnowledgeId, null);
  assert.equal(qidNow.publishedVersionId, null);
  assert.equal(qidNow.selectedVersionId, editId);
  assert.equal(qidNow.versions.length, qidDraft.versions.length);
  assert.equal(qidNow.status, "generating");
  assert.equal((await store.readThread(owner, courseId, qid)).resolvedAt, qidResolvedAt);
  await runDraftGeneration(midGen.generation, fixtureAi());
  qidNow = await store.readDraft(teacher, courseId, qid);
  assert.equal(qidNow.status, "ready");
  assert.equal(qidNow.selectedVersionId, editId);
  assert.equal(qidNow.versions.length, qidDraft.versions.length + 1);
  ok("取り下げは担当教員だけ。生成中でも取り下げられ、候補は公開していた版を選んだ確認待ちに戻る（版の履歴・resolvedAt は不変）");

  assert.ok(!(await store.listPublishedKnowledge(other, courseId)).some((k) => k.id === k1));
  await rejectsWith(store.readPublishedKnowledge(other, courseId, k1), "NOT_FOUND");
  assert.ok(!(await store.listKnowledgeForAnswer(courseId, [content.categoryId])).some((k) => k.id === k1));
  assert.ok(!(await store.listTeacherKnowledge(teacher, courseId)).some((k) => k.id === k1));
  await rejectsWith(store.listTeacherKnowledge(owner, courseId), "NOT_FOUND");
  const ownerAfter = JSON.stringify(await store.readThread(owner, courseId, qid));
  assert.ok(!ownerAfter.includes(content.answer));
  assert.ok(!ownerAfter.includes("生徒 太郎"));
  ok("取り下げたQ&Aは生徒の一覧・詳細（404）・AI の検索・教員の一覧に出ない。生徒用DTOに候補本文・本人表示は入らない");

  await rejectsWith(store.unpublishKnowledge(teacher, courseId, k1), "NOT_FOUND");
  const k2 = await store.publishDraft(teacher, courseId, qid, publishInput);
  assert.notEqual(k2.id, k1);
  await rejectsWith(store.unpublishKnowledge(teacher, courseId, k1), "NOT_FOUND");
  assert.ok((await store.listPublishedKnowledge(other, courseId)).some((k) => k.id === k2.id));
  ok("取り下げ済みの ID への要求は 404。再公開は新しい ID を発行し、古い取り下げ要求は新しい公開を消さない");

  // 公開と取り下げの同時要求でも、候補と knowledge が矛盾しない
  await Promise.allSettled([
    store.unpublishKnowledge(teacher, courseId, k2.id),
    store.publishDraft(teacher, courseId, qid, publishInput),
  ]);
  const finalDraft = await store.readDraft(teacher, courseId, qid);
  const sourceKnowledge = (await db.collection("courses").doc(courseId).collection("knowledge").get()).docs
    .filter((doc) => doc.data().sourceQuestionId === qid);
  if (finalDraft.publication === "published") {
    assert.equal(sourceKnowledge.length, 1);
    assert.equal(sourceKnowledge[0].id, finalDraft.publishedKnowledgeId);
  } else {
    assert.equal(finalDraft.publication, "none");
    assert.equal(sourceKnowledge.length, 0);
    assert.equal(finalDraft.publishedKnowledgeId, null);
  }
  ok("公開と取り下げを同時に送っても、候補の公開状態と knowledge が一致する");

  // 元候補の現在の公開と一致しない Q&A は消さない（409）、元候補がない Q&A は削除だけ
  const strayRef = db.collection("courses").doc(courseId).collection("knowledge").doc();
  const nnKnowledge = (await db.collection("courses").doc(courseId).collection("knowledge").doc(nnPublished.id).get()).data();
  await strayRef.create({ ...nnKnowledge, publishedAt: Timestamp.now() });
  await rejectsWith(store.unpublishKnowledge(teacher, courseId, strayRef.id), "CONFLICT");
  assert.equal((await strayRef.get()).exists, true);
  await strayRef.delete();
  const seedRef = db.collection("courses").doc(courseId).collection("knowledge").doc();
  await seedRef.create({
    question: "初期データ", answer: "シードで直接入れたQ&A", categoryId: "vertex", publishedAt: Timestamp.now(),
    publishedByUid: "seed", sourceQuestionId: "seed", sourceVersionId: "seed", createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
  });
  assert.deepEqual(await store.unpublishKnowledge(teacher, courseId, seedRef.id), {
    knowledgeId: seedRef.id, status: "unpublished", questionId: null,
  });
  assert.equal((await seedRef.get()).exists, false);
  ok("元候補の現在の公開と一致しない Q&A は消さない（409）。元候補がない初期データは削除だけ行う");

  // 先生の対応待ちに補足が続いても、最初の質問と要約に使える回答が残る。
  const longThread = await store.createQuestion(owner, courseId, { text: "平方完成で頂点を求める方法は？" });
  const longId = longThread.thread.id;
  const longAnswer = `平方完成で求めます。${"解".repeat(3000)}`;
  await store.finishAiTurn(longThread.aiTurn, {
    text: longAnswer, referencedKnowledgeIds: [], escalate: false, reason: "",
  });
  const followup = await store.addStudentMessage(owner, courseId, longId, { text: "この場合はどうなりますか？" });
  assert.ok(followup.aiTurn);
  await store.finishAiTurn(followup.aiTurn, {
    text: "先生に引き継ぎます。", referencedKnowledgeIds: [], escalate: true, reason: "問題の条件が不明です。",
  });
  const longRef = db.collection("courses").doc(courseId).collection("questions").doc(longId);
  const supplements = db.batch();
  for (let sequence = 5; sequence <= 24; sequence++) {
    supplements.create(longRef.collection("messages").doc(String(sequence).padStart(6, "0")), {
      role: "student", text: `補足${sequence}`, sequence, authorUid: ownerP.uid,
      referencedKnowledgeIds: [], lowConfidence: false, createdAt: now,
    });
  }
  supplements.update(longRef, { messageCount: 24 });
  await supplements.commit();
  const longResolution = await store.resolveQuestion(owner, courseId, longId);
  assert.ok(longResolution.generation);
  assert.deepEqual(await runDraftGeneration(longResolution.generation, fixtureAiWorkflow), { applied: true, ok: true });
  assert.equal(longResolution.generation.messages.length, 20);
  assert.equal(longResolution.generation.messages[0].sequence, 1);
  assert.equal(longResolution.generation.messages[1].text, longAnswer);
  assert.equal(longResolution.generation.messages.at(-1)?.sequence, 24);
  assert.ok(!longResolution.generation.messages.some(({ sequence }) => sequence === 4));
  assert.equal((await store.readThread(owner, courseId, longId)).messages.length, 24);
  assert.equal((await store.readDraft(teacher, courseId, longId)).status, "ready");
  ok("長い会話から初回質問・直近の補足・要約に使える長文の回答を渡し、保存した24発言を保ったまま候補を作る");

  console.log(`PASS: ${passed.length} 件の権限・状態遷移・競合の確認が通った。`);
}

async function cleanup() {
  try {
    for (const id of [courseId, otherCourseId]) await db.recursiveDelete(db.collection("courses").doc(id));
    await Promise.all(["owner", "noname", "outsider", "limited"].map((role) =>
      db.collection("inviteAttempts").doc(`${role}-${runId}`).delete(),
    ));
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
