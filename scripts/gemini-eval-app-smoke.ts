// 配信コミットのローカル実アプリに対する回帰確認。クラウド Firestore と Firebase Auth は使わない。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { deleteApp, getApps } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import type {
  ApiSuccess,
  InviteDTO,
  KnowledgeDraftDTO,
  MessageDTO,
  PublishedKnowledgeDTO,
  StudentNotificationDTO,
  StudentThreadDetailDTO,
  TeacherThreadDetailDTO,
  ThreadSummaryDTO,
} from "../src/domain/course-workflow.ts";
import { isQuestionExcerpt } from "../src/domain/question-title.ts";
import { getAuthAdmin, getFirestoreAdmin } from "../src/server/firestore/admin.ts";
import { ensureUser, signIn } from "./emulator-users.ts";

const model = process.env.GEMINI_MODEL;
const mode = process.env.GEMINI_EVAL_APP_MODE;
const base = "http://127.0.0.1:3102";
assert.ok(model && /^gemini-(?:3\.1-flash-lite|3\.5-flash(?:-lite)?|3\.8-flash)$/.test(model), "Invalid evaluation model.");
assert.ok(mode === "--mock" || mode === "--approved", "Select an explicit evaluation mode.");
assert.equal(process.env.GEMINI_EVAL_APP_URL, base);
assert.equal(process.env.GCLOUD_PROJECT, "demo-gdgoc-japan-hackathon-2026");
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:8080");
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, "127.0.0.1:9099");
assert.equal(process.env.GOOGLE_VERTEX_BASE_URL, mode === "--mock" ? "http://127.0.0.1:3198" : "http://127.0.0.1:3199");

const privateName = "架空花子";
const privateEmail = "qa-private-example@example.test";
const courseId = `gemini-app-${randomUUID()}`;
const knowledgeId = "square-completion";
const path = `/api/courses/${courseId}`;
const users = ["student", "teacher"].map((role) => ({
  uid: `${courseId}-${role}`,
  email: `${courseId}-${role}@example.test`,
  name: role === "student" ? privateName : "架空教員",
}));
const db = getFirestoreAdmin();
const course = db.collection("courses").doc(courseId);
const traces: { step: string; elapsedMs: number; http: number; output?: unknown }[] = [];

async function call(method: "GET" | "POST", url: string, cookie?: string, body?: unknown) {
  return fetch(`${base}${url}`, {
    method,
    headers: { origin: base, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(75_000),
  });
}

async function data<T>(response: Response, status = 200) {
  assert.equal(response.status, status, "Unexpected application HTTP status.");
  return ((await response.json()) as ApiSuccess<T>).data;
}

async function login(uid: string) {
  const response = await call("POST", "/api/auth/session", undefined, { idToken: await signIn(uid) });
  assert.equal(response.status, 200, "Emulator session setup failed.");
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "Session Cookie was not set.");
  return cookie;
}

async function modelOperation(step: string, url: string, cookie: string, body: unknown, status = 200) {
  const start = performance.now();
  const response = await call("POST", url, cookie, body);
  const trace: (typeof traces)[number] = { step, elapsedMs: Math.round(performance.now() - start), http: response.status };
  traces.push(trace);
  const thread = await data<StudentThreadDetailDTO>(response, status);
  const last = thread.messages.at(-1);
  trace.output = {
    status: thread.status, escalatedBy: thread.escalatedBy, summaryStatus: thread.summaryStatus, categoryIds: thread.categoryIds,
    ...(last?.role === "assistant" ? { text: last.text, references: last.referencedKnowledgeIds ?? [] } : {}),
  };
  return thread;
}

function lastAssistant(thread: StudentThreadDetailDTO): MessageDTO {
  const last = thread.messages.at(-1);
  assert.ok(last && last.role === "assistant" && last.text.trim().length > 0, "Expected an AI response saved to the thread.");
  return last;
}

function normalized(text: string) {
  return text.normalize("NFKC").replaceAll("−", "-").replaceAll("–", "-");
}

async function exercise() {
  const now = Timestamp.now();
  await course.create({
    name: "架空講義: 数学I",
    teacherEmails: [users[1].email],
    categories: [{ id: "other", name: "その他", order: 0 }],
    materials: [],
    createdAt: now,
  });
  await course.collection("knowledge").doc(knowledgeId).create({
    question: "授業の平方完成の記法は？",
    answer: "この講義では平方完成後の式を y=(x-h)^2+k と書き、頂点の座標を (h,k) と読みます。",
    categoryId: "other",
    publishedAt: now,
    publishedByUid: users[1].uid,
    sourceQuestionId: "synthetic-source",
    sourceVersionId: "synthetic-version",
    createdAt: now,
    updatedAt: now,
  });
  await Promise.all(users.map(ensureUser));
  const student = await login(users[0].uid);
  const teacher = await login(users[1].uid);
  const invite = await data<InviteDTO>(await call("POST", `${path}/teacher/invite`, teacher, {}), 201);
  await data(await call("POST", `${path}/join`, student, { code: invite.code }));

  // 1–2回目: 初回分類と、公開Q&Aを参照した学習回答。
  const first = await modelOperation("initial-classification-and-grounded-answer", `${path}/questions`, student, {
    text: `氏名:${privateName}。公開Q&Aの記法で $y=x^2-6x+5$ の頂点は？根拠も示して。`,
  }, 201);
  assert.equal(first.status, "ai_answered", "An answerable question did not finish as AI answered.");
  assert.deepEqual(first.categoryIds, ["other"]);
  assert.ok(!isQuestionExcerpt(first.title), "Follow-up would consume an extra title-classification call.");
  const firstReply = lastAssistant(first);
  assert.deepEqual(firstReply.referencedKnowledgeIds, [knowledgeId], "The supplied source was not cited.");
  assert.ok(/3\s*[,、]\s*-\s*4/.test(normalized(firstReply.text)), "The vertex in the first answer is incorrect or missing.");
  const referenced = await data<PublishedKnowledgeDTO>(await call("GET", `${path}/knowledge/${knowledgeId}`, student));
  assert.equal(referenced.id, knowledgeId);
  assert.equal("sourceQuestionId" in referenced, false);

  // 3回目: 条件を繰り返さず、直前の二次関数の式を使う追加質問。
  const followup = await modelOperation("contextual-followup", `${path}/questions/${first.id}/messages`, student, {
    text: `上の式で $x=4$ を代入した $y$ は？ 連絡先の例は ${privateEmail} です。`,
  });
  assert.equal(followup.status, "ai_answered");
  assert.deepEqual(followup.messages.map(({ role }) => role), ["student", "assistant", "student", "assistant"]);
  assert.ok(/-\s*3(?!\d)/.test(normalized(lastAssistant(followup).text)), "The contextual substitution result is incorrect or missing.");

  // 4–5回目: 分類は通常どおり。無関係な公開Q&Aがあっても試験範囲は推測せず引き継ぐ。
  const handoff = await modelOperation("initial-classification-and-teacher-handoff", `${path}/questions`, student, {
    text: "この講義の次回の追試で平方完成は出題されますか。公表されていなければ先生に確認してください。",
  }, 201);
  assert.equal(handoff.status, "escalated", "The teacher-only question did not enter the handoff state.");
  assert.equal(handoff.escalatedBy, "ai");
  assert.equal(handoff.actions.canSendMessage, true);
  assert.equal(handoff.actions.canEscalate, false);
  const waiting = await data<ThreadSummaryDTO[]>(await call("GET", `${path}/teacher/questions?status=escalated`, teacher));
  assert.ok(waiting.some(({ id }) => id === handoff.id), "The teacher queue does not contain the handoff.");
  const detail = await data<TeacherThreadDetailDTO>(await call("GET", `${path}/questions/${handoff.id}`, teacher));
  assert.equal(detail.actions.canReply, true);
  const handoffReply = lastAssistant(handoff);
  const stored = await course.collection("questions").doc(handoff.id).collection("messages").doc(handoffReply.id).get();
  assert.equal(stored.get("lowConfidence"), true);
  const supplement = await data<StudentThreadDetailDTO>(await call("POST", `${path}/questions/${handoff.id}/messages`, student, {
    text: "来週の追試についての質問です。",
  }));
  assert.equal(supplement.status, "escalated");
  assert.equal(supplement.messages.length, handoff.messages.length + 1);
  assert.equal(supplement.messages.at(-1)?.role, "student");
  const teacherReply = await data<TeacherThreadDetailDTO>(await call("POST", `${path}/teacher/questions/${handoff.id}/reply`, teacher, {
    text: "追試範囲はまだ公表していません。決まり次第、講義の案内で知らせます。",
  }));
  assert.equal(teacherReply.status, "teacher_answered");
  const notices = await data<StudentNotificationDTO[]>(await call("GET", `${path}/notifications`, student));
  const notice = notices.find(({ questionId }) => questionId === handoff.id);
  assert.ok(notice && notice.readAt === null, "Teacher reply did not create an unread notification.");
  const read = await data<StudentNotificationDTO>(await call("POST", `${path}/notifications/${notice.id}/read`, student, {}));
  assert.ok(read.readAt, "Notification did not become read.");

  // 6回目: 学習会話を解決し、匿名化した共有候補ができることを確認。公開はまだされない。
  const resolved = await modelOperation("resolution-and-anonymous-summary", `${path}/questions/${first.id}/resolve`, student, {});
  assert.ok(resolved.resolvedAt);
  assert.equal(resolved.summaryStatus, "ready");
  assert.equal(resolved.actions.canSendMessage, false);
  const draftPath = `${path}/teacher/knowledge-drafts/${first.id}`;
  assert.equal((await call("GET", draftPath, student)).status, 404);
  const draft = await data<KnowledgeDraftDTO>(await call("GET", draftPath, teacher));
  assert.equal(draft.publication, "none");
  assert.equal(draft.versions.length, 1);
  const version = draft.versions[0];
  assert.equal(version.kind, "generated");
  const summary = `${version.question}\n${version.answer}`;
  traces.push({ step: "teacher-only-unpublished-draft", elapsedMs: 0, http: 200, output: {
    question: version.question, answer: version.answer, publication: draft.publication,
  } });
  assert.ok(!summary.includes(privateName) && !summary.includes(privateEmail), "Synthetic private information remained in the draft.");
  assert.ok(/3\s*[,、]\s*-\s*4/.test(normalized(summary)), "The draft does not preserve the core mathematical answer.");
  const publicKnowledge = await data<PublishedKnowledgeDTO[]>(await call("GET", `${path}/knowledge`, student));
  assert.deepEqual(publicKnowledge.map(({ id }) => id), [knowledgeId]);
  if (mode === "--mock") {
    const response = await fetch("http://127.0.0.1:3198/health", { signal: AbortSignal.timeout(2000) });
    assert.equal(((await response.json()) as { generated: number }).generated, 6, "Unexpected count of model calls.");
  }
}

let failure: string | null = null;
try {
  await exercise();
} catch (error) {
  failure = error instanceof assert.AssertionError ? error.message : "An application or emulator request failed.";
  process.exitCode = 1;
} finally {
  await Promise.allSettled([db.recursiveDelete(course), getAuthAdmin().deleteUsers(users.map(({ uid }) => uid))]);
  await Promise.all(getApps().map(deleteApp));
  await mkdir("test-results", { recursive: true });
  const result = { model, mode, passed: failure === null, failure, traces };
  const output = `test-results/gemini-eval-app-${mode === "--mock" ? "mock-" : ""}${model}.json`;
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(`${result.passed ? "PASS" : "FAIL"} ${model}: ${output}`);
  if (failure) console.error(failure);
}
