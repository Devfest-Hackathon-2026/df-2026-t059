import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type Firestore, Timestamp, type Transaction } from "firebase-admin/firestore";
import { z } from "zod";
import type { AiAnswer } from "../../domain/ai-answer.ts";
import type {
  CourseCategory,
  CourseViewDTO,
  CourseViewerDTO,
  DraftGenerationReason,
  InviteDTO,
  InviteStatusDTO,
  KnowledgeDraftDTO,
  KnowledgeDraftListDTO,
  MessageDTO,
  PublishedKnowledgeDTO,
  QuestionStatus,
  StudentThreadDetailDTO,
  StudentNotificationDTO,
  SummaryStatus,
  TeacherThreadDetailDTO,
  ThreadDetailDTO,
  UnpublishKnowledgeResultDTO,
  ThreadSummaryDTO,
} from "../../domain/course-workflow.ts";
import {
  AI_ANSWER_MAX_LENGTH,
  AI_CONTEXT_MAX_MESSAGES,
  AI_TURN_TIMEOUT_MS,
  CATEGORY_NAME_MAX_LENGTH,
  COURSE_NAME_MAX_LENGTH,
  DRAFT_ANSWER_MAX_LENGTH,
  DRAFT_GENERATION_TIMEOUT_MS,
  DRAFT_QUESTION_MAX_LENGTH,
  INVITE_ATTEMPT_WINDOW_MS,
  INVITE_DURATION_MS,
  INVITE_MAX_FAILURES,
  KNOWLEDGE_FOR_ANSWER_LIMIT,
  MAX_QUESTION_CATEGORIES,
  MESSAGE_MAX_LENGTH,
  RELATED_CONTEXT_MAX_MESSAGES,
  THREAD_TITLE_MAX_LENGTH,
} from "../../domain/limits.ts";
import { generatedQuestionTitle, isQuestionExcerpt, questionHeading } from "../../domain/question-title.ts";
import {
  type CourseActor,
  canActAsStudent,
  canActAsTeacher,
  canCreateCourse,
  canReadCourse,
  canReadThread,
  isTeacherEmail,
  isThreadOwner,
  type Principal,
} from "../auth/access.ts";
import { conflict, forbidden, invalidInput, notFound, tooManyRequests } from "../errors.ts";
import {
  type Decision,
  decideAiRetry,
  decideDismiss,
  decideEscalate,
  decideGenerationRequest,
  decidePublish,
  decideResolve,
  decideRestore,
  decideStudentMessage,
  decideTeacherReply,
  decideUnpublish,
  aiTurnExpired,
  formatInviteCode,
  INVITE_ALPHABET,
  isExpired,
  makeTitle,
  normalizeCategoryIds,
  normalizeInviteCode,
} from "../workflow/rules.ts";
import { getFirestoreAdmin } from "./admin.ts";
import {
  mirrorFromRecord,
  mirrorRecordFromDraft,
  threadState,
  toDraftDTO,
  toDraftListItem,
  toDraftVersionDTO,
  toMessageDTO,
  toPublishedKnowledge,
  toStudentThreadDetail,
  toTeacherThreadDetail,
  toThreadSummary,
} from "./dto.ts";
import {
  type Course,
  courseSchema,
  type Draft,
  type DraftGenerationRef,
  draftSchema,
  draftVersionSchema,
  enrollmentSchema,
  type Invite,
  inviteAttemptSchema,
  inviteSchema,
  type Knowledge,
  knowledgeSchema,
  type Message,
  messageSchema,
  notificationSchema,
  type Question,
  questionSchema,
} from "./models.ts";

// ---------------------------------------------------------------------------
// 共通の約束
// - actor を受け取る関数は、HTTP の入口が requireCourseActor で検証した主体を渡す。
//   関数の中でも src/server/auth/access.ts の同じ判定を必ず通す（入口の確認漏れを防ぐ）。
// - ticket（AiTurnTicket / DraftGenerationTicket）を受け取る関数は、actor 付きの begin 系関数が
//   発行した試行IDで照合する。試行IDが一致しない（古い・置き換え済み）結果は保存しない。
//   ticket はサーバー内だけで受け渡し、ブラウザに返さない。
// - Gemini の呼び出しはトランザクションの外。begin 系 → AI → finish/fail 系の順に呼ぶ。
// ---------------------------------------------------------------------------

const documentId = z.string().min(1).max(200).refine(
  (id) => !id.includes("/") && id !== "." && id !== ".." && !/^__.*__$/.test(id),
  "Expected one Firestore document ID.",
);

const messageText = z.string().trim().min(1).max(MESSAGE_MAX_LENGTH);

function parseId(value: string): string {
  const parsed = documentId.safeParse(value);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

function parseText(value: unknown): string {
  const parsed = messageText.safeParse(value);
  if (!parsed.success) throw invalidInput(`本文は1〜${MESSAGE_MAX_LENGTH}文字で入力してください。`);
  return parsed.data;
}

function unwrap<T>(decision: Decision<T>): T {
  if (!decision.ok) throw conflict(decision.reason);
  return decision.value;
}

const db = (): Firestore => getFirestoreAdmin();
const courseRef = (courseId: string) => db().collection("courses").doc(parseId(courseId));
const questionRef = (courseId: string, questionId: string) =>
  courseRef(courseId).collection("questions").doc(parseId(questionId));
const messagesCol = (courseId: string, questionId: string) => questionRef(courseId, questionId).collection("messages");
const messageRef = (courseId: string, questionId: string, sequence: number) =>
  messagesCol(courseId, questionId).doc(String(sequence).padStart(6, "0"));
const draftRef = (courseId: string, questionId: string) =>
  courseRef(courseId).collection("knowledgeDrafts").doc(parseId(questionId));
const versionsCol = (courseId: string, questionId: string) => draftRef(courseId, questionId).collection("versions");
const generationsCol = (courseId: string, questionId: string) =>
  draftRef(courseId, questionId).collection("generations");
const knowledgeCol = (courseId: string) => courseRef(courseId).collection("knowledge");
const enrollmentRef = (courseId: string, uid: string) => courseRef(courseId).collection("enrollments").doc(parseId(uid));
const notificationsCol = (courseId: string, uid: string) => enrollmentRef(courseId, uid).collection("notifications");
const invitesCol = (courseId: string) => courseRef(courseId).collection("invites");

const after = (now: Timestamp, ms: number) => Timestamp.fromMillis(now.toMillis() + ms);

async function readCourse(tx: Transaction | null, courseId: string): Promise<Course> {
  const ref = courseRef(courseId);
  const snap = tx ? await tx.get(ref) : await ref.get();
  if (!snap.exists) throw notFound();
  return courseSchema.parse(snap.data());
}

async function readQuestion(tx: Transaction, courseId: string, questionId: string): Promise<Question> {
  const snap = await tx.get(questionRef(courseId, questionId));
  if (!snap.exists) throw notFound();
  return questionSchema.parse(snap.data());
}

async function readDraftOrNull(tx: Transaction, courseId: string, questionId: string): Promise<Draft | null> {
  const snap = await tx.get(draftRef(courseId, questionId));
  return snap.exists ? draftSchema.parse(snap.data()) : null;
}

function isSummaryAnswer(message: Message) {
  return message.role !== "student" && !message.lowConfidence && !!message.text.trim();
}

async function readThreadMessages(courseId: string, questionId: string, question: Question) {
  const snap = await messagesCol(courseId, questionId).orderBy("sequence").get();
  const records = snap.docs.map((doc) => ({ id: doc.id, message: messageSchema.parse(doc.data()) }));
  // すでに解決済みの旧データでも、回答のない会話に要約の再試行を案内しない。
  const sharingExcluded = question.sharingExcluded ?? (!!question.resolvedAt && !records.some(({ message }) => isSummaryAnswer(message)));
  return { question: { ...question, sharingExcluded }, messages: records.map(({ id, message }) => toMessageDTO(id, message)) };
}

async function hasSummaryAnswer(tx: Transaction, courseId: string, questionId: string) {
  const replies = await tx.get(messagesCol(courseId, questionId).where("role", "in", ["teacher", "assistant"]));
  return replies.docs.some((doc) => isSummaryAnswer(messageSchema.parse(doc.data())));
}

async function assertSharingAllowed(tx: Transaction, courseId: string, questionId: string, question: Question) {
  if (question.sharingExcluded || (question.sharingExcluded === undefined && question.resolvedAt && !await hasSummaryAnswer(tx, courseId, questionId))) {
    throw conflict("回答がないため、この会話は共有候補にできません。");
  }
}

function appendMessage(
  tx: Transaction,
  courseId: string,
  questionId: string,
  sequence: number,
  data: Omit<Message, "sequence">,
) {
  tx.create(messageRef(courseId, questionId, sequence), { ...data, sequence } satisfies Message);
}

/** 本人の操作（持ち主でなければ、教員には 403、それ以外には存在を明かさず 404）。 */
function assertOwner(actor: CourseActor, courseId: string, question: Question) {
  const thread = { courseId, studentId: question.studentId };
  if (isThreadOwner(actor, thread)) return;
  throw canReadThread(actor, thread) ? forbidden() : notFound();
}

function assertTeacher(actor: CourseActor, courseId: string) {
  if (!canActAsTeacher(actor, courseId)) throw notFound();
}

function assertStudent(actor: CourseActor, courseId: string) {
  if (!canActAsStudent(actor, courseId)) throw forbidden("この講義に参加していません。招待URLまたは参加コードから参加してください。");
}

// ---------------------------------------------------------------------------
// 講義
// ---------------------------------------------------------------------------

const courseCreationSchema = z.strictObject({
  name: z.string().trim().min(1).max(COURSE_NAME_MAX_LENGTH),
  requestId: z.uuid(),
});

async function createCourse(principal: Principal, input: unknown): Promise<string> {
  if (!canCreateCourse(principal)) throw forbidden("確認済みのメールアドレスがあるGoogleアカウントでログインしてください。");
  const parsed = courseCreationSchema.safeParse(input);
  if (!parsed.success) throw invalidInput(`講義名を1〜${COURSE_NAME_MAX_LENGTH}文字で入力してください。`);

  const { name, requestId } = parsed.data;
  // 同じ利用者の同じ要求は、通信失敗後の再送でも同じ講義になる。
  const id = createHash("sha256").update(JSON.stringify([principal.uid, requestId])).digest("hex").slice(0, 24);
  const ref = courseRef(id);
  return db().runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (existing.exists) {
      const course = courseSchema.parse(existing.data());
      if (!isTeacherEmail(principal.email, course.teacherEmails) || course.name !== name) {
        throw conflict("この作成操作は処理済みです。講義一覧を確認してください。");
      }
      return id;
    }

    const now = Timestamp.now();
    const course: Course = {
      name,
      teacherEmails: [principal.email],
      categories: [{ id: "other", name: "その他", order: 0 }],
      materials: [],
      createdAt: now,
      updatedAt: now,
    };
    tx.create(ref, course);
    return id;
  });
}

function sortedCategories(course: Course): CourseCategory[] {
  return [...course.categories].sort((a, b) => a.order - b.order);
}

async function getCourseView(actor: CourseActor, courseId: string): Promise<CourseViewDTO> {
  if (!canReadCourse(actor, courseId)) throw notFound();
  const course = await readCourse(null, courseId);
  return { id: courseId, name: course.name, categories: sortedCategories(course) };
}

function getCourseViewer(actor: CourseActor): CourseViewerDTO {
  return { enrolled: actor.enrolled, teacher: actor.teacher };
}

// ---------------------------------------------------------------------------
// 読み出し
// ---------------------------------------------------------------------------

async function readThread(actor: CourseActor, courseId: string, questionId: string): Promise<ThreadDetailDTO> {
  const snap = await questionRef(courseId, questionId).get();
  if (!snap.exists) throw notFound();
  const question = questionSchema.parse(snap.data());
  const thread = { courseId, studentId: question.studentId };
  if (!canReadThread(actor, thread)) throw notFound();
  const content = await readThreadMessages(courseId, questionId, question);
  const nowMs = Date.now();
  return canActAsTeacher(actor, courseId)
    ? toTeacherThreadDetail(snap.id, content.question, content.messages, nowMs)
    : toStudentThreadDetail(snap.id, content.question, content.messages, nowMs);
}

async function readStudentThread(courseId: string, questionId: string): Promise<StudentThreadDetailDTO> {
  const snap = await questionRef(courseId, questionId).get();
  const question = questionSchema.parse(snap.data());
  const content = await readThreadMessages(courseId, questionId, question);
  return toStudentThreadDetail(snap.id, content.question, content.messages, Date.now());
}

async function readTeacherThread(courseId: string, questionId: string): Promise<TeacherThreadDetailDTO> {
  const snap = await questionRef(courseId, questionId).get();
  const question = questionSchema.parse(snap.data());
  const content = await readThreadMessages(courseId, questionId, question);
  return toTeacherThreadDetail(snap.id, content.question, content.messages, Date.now());
}

async function listOwnThreads(actor: CourseActor, courseId: string): Promise<ThreadSummaryDTO[]> {
  assertStudent(actor, courseId);
  const snap = await courseRef(courseId).collection("questions")
    .where("studentId", "==", actor.principal.uid)
    .orderBy("updatedAt", "desc")
    .limit(100)
    .get();
  const nowMs = Date.now();
  return snap.docs.map((doc) => toThreadSummary(doc.id, questionSchema.parse(doc.data()), nowMs));
}

async function listTeacherThreads(
  actor: CourseActor,
  courseId: string,
  status: QuestionStatus,
): Promise<ThreadSummaryDTO[]> {
  assertTeacher(actor, courseId);
  const snap = await courseRef(courseId).collection("questions")
    .where("status", "==", status)
    .orderBy("updatedAt", "desc")
    .limit(100)
    .get();
  const nowMs = Date.now();
  return snap.docs.map((doc) => toThreadSummary(doc.id, questionSchema.parse(doc.data()), nowMs));
}

async function listPublishedKnowledge(
  actor: CourseActor,
  courseId: string,
  options: { categoryIds?: string[]; limit?: number } = {},
): Promise<PublishedKnowledgeDTO[]> {
  if (!canReadCourse(actor, courseId)) throw notFound();
  return queryPublishedKnowledge(courseId, options.categoryIds, Math.min(options.limit ?? 200, 200));
}

async function readPublishedKnowledge(actor: CourseActor, courseId: string, knowledgeId: string): Promise<PublishedKnowledgeDTO> {
  if (!canReadCourse(actor, courseId)) throw notFound();
  const snapshot = await knowledgeCol(courseId).doc(parseId(knowledgeId)).get();
  if (!snapshot.exists) throw notFound();
  return toPublishedKnowledge(snapshot.id, knowledgeSchema.parse(snapshot.data()));
}

function toNotification(id: string, value: unknown): StudentNotificationDTO {
  const notice = notificationSchema.parse(value);
  return {
    id, questionId: notice.questionId, messageId: notice.messageId, title: questionHeading(notice.title),
    createdAt: notice.createdAt.toDate().toISOString(), readAt: notice.readAt?.toDate().toISOString() ?? null,
  };
}

async function listNotifications(actor: CourseActor, courseId: string): Promise<StudentNotificationDTO[]> {
  assertStudent(actor, courseId);
  const snapshot = await notificationsCol(courseId, actor.principal.uid).orderBy("createdAt", "desc").get();
  return snapshot.docs.map((document) => toNotification(document.id, document.data()));
}

async function markNotificationRead(actor: CourseActor, courseId: string, notificationId: string): Promise<StudentNotificationDTO> {
  assertStudent(actor, courseId);
  const reference = notificationsCol(courseId, actor.principal.uid).doc(parseId(notificationId));
  return db().runTransaction(async (tx) => {
    const snapshot = await tx.get(reference);
    if (!snapshot.exists) throw notFound();
    const notice = notificationSchema.parse(snapshot.data());
    if (notice.readAt) return toNotification(snapshot.id, notice);
    const readAt = Timestamp.now();
    tx.update(reference, { readAt });
    return toNotification(snapshot.id, { ...notice, readAt });
  });
}

async function queryPublishedKnowledge(courseId: string, categoryIds: string[] | undefined, limit: number) {
  let query = knowledgeCol(courseId).orderBy("publishedAt", "desc");
  if (categoryIds?.length) query = query.where("categoryId", "in", categoryIds.slice(0, 10));
  const snap = await query.limit(limit).get();
  return snap.docs.map((doc) => toPublishedKnowledge(doc.id, knowledgeSchema.parse(doc.data())));
}

// ---------------------------------------------------------------------------
// 会話と AI の回答
// ---------------------------------------------------------------------------

/** AI の回答1回分の試行。A のサーバー処理だけが受け渡す。 */
export type AiTurnTicket = { courseId: string; questionId: string; attemptId: string; firstTurn: boolean };

/** AI に渡す入力。会話は保存済みの発言だけ。 */
export type AiTurnContext = {
  messages: MessageDTO[];
  categories: CourseCategory[];
  /** 追加質問では保存済みのカテゴリ。初回は空（setAiCategories で確定する）。 */
  categoryIds: string[];
  firstMessageText: string;
  needsTitle: boolean;
};

function newAttempt(now: Timestamp) {
  return { id: randomUUID(), startedAt: now, expiresAt: after(now, AI_TURN_TIMEOUT_MS) };
}

const AI_TIMEOUT_CODE = "ai_timeout";

function isRawAiTurnExpired(question: Question, now: Timestamp): boolean {
  return aiTurnExpired(
    {
      status: question.status,
      resolved: !!question.resolvedAt,
      aiAttempt: question.aiAttempt ? { id: question.aiAttempt.id, expiresAtMs: question.aiAttempt.expiresAt.toMillis() } : null,
      draft: null,
    },
    now.toMillis(),
  );
}

/**
 * 期限切れの AI 回答を失敗（error）として閉じる更新。期限切れの相談から別の状態へ移るときに一緒に書き込み、
 * 保存上の状態を画面・判定（effectiveThreadState）と揃える。期限切れでなければ空。
 */
function closeExpiredAiTurn(question: Question, now: Timestamp): Record<string, unknown> {
  return isRawAiTurnExpired(question, now) ? { status: "error", aiAttempt: null, lastErrorCode: AI_TIMEOUT_CODE } : {};
}

async function createQuestion(
  actor: CourseActor,
  courseId: string,
  input: { text: unknown; sourceQuestionId?: unknown },
): Promise<{ thread: StudentThreadDetailDTO; aiTurn: AiTurnTicket }> {
  assertStudent(actor, courseId);
  const text = parseText(input.text);
  const sourceId = input.sourceQuestionId === undefined ? undefined : z.string().min(1).max(200).parse(input.sourceQuestionId);
  const ref = courseRef(courseId).collection("questions").doc();
  const now = Timestamp.now();
  const attempt = newAttempt(now);
  const { principal } = actor;
  await db().runTransaction(async (tx) => {
    await readCourse(tx, courseId);
    let relatedQuestion: Question["relatedQuestion"];
    if (sourceId !== undefined) {
      const source = await readQuestion(tx, courseId, sourceId);
      assertOwner(actor, courseId, source);
      const first = await tx.get(messageRef(courseId, sourceId, 1));
      const latest = await tx.get(messagesCol(courseId, sourceId).orderBy("sequence", "desc").limit(RELATED_CONTEXT_MAX_MESSAGES - 1));
      const records = [first, ...latest.docs].filter((document) => document.exists)
        .map((document) => messageSchema.parse(document.data()));
      const messages = [...new Map(records.map((message) => [message.sequence, message])).values()]
        .sort((a, b) => a.sequence - b.sequence)
        .map((message) => ({ role: message.role, text: message.text.slice(0, MESSAGE_MAX_LENGTH), createdAt: message.createdAt.toDate().toISOString() }));
      relatedQuestion = { id: sourceId, title: source.title, messages };
    }
    const question: Question = {
      studentId: principal.uid,
      studentDisplayName: principal.name ?? principal.email,
      title: makeTitle(text, THREAD_TITLE_MAX_LENGTH),
      categoryIds: [],
      status: "pending",
      escalatedBy: null,
      resolvedAt: null,
      messageCount: 1,
      aiAttempt: attempt,
      lastErrorCode: null,
      draft: null,
      createdAt: now,
      updatedAt: now,
      ...(relatedQuestion ? { relatedQuestion } : {}),
    };
    tx.create(ref, question);
    appendMessage(tx, courseId, ref.id, 1, {
      role: "student",
      text,
      authorUid: principal.uid,
      referencedKnowledgeIds: [],
      lowConfidence: false,
      createdAt: now,
    });
  });
  return {
    thread: await readStudentThread(courseId, ref.id),
    aiTurn: { courseId, questionId: ref.id, attemptId: attempt.id, firstTurn: true },
  };
}

async function addStudentMessage(
  actor: CourseActor,
  courseId: string,
  questionId: string,
  input: { text: unknown },
): Promise<{ thread: StudentThreadDetailDTO; aiTurn: AiTurnTicket | null }> {
  assertStudent(actor, courseId);
  const text = parseText(input.text);
  const now = Timestamp.now();
  const ticket = await db().runTransaction(async (tx) => {
    const question = await readQuestion(tx, courseId, questionId);
    assertOwner(actor, courseId, question);
    const { nextStatus, startAiTurn } = unwrap(decideStudentMessage(threadState(question, now.toMillis())));
    const sequence = question.messageCount + 1;
    const attempt = startAiTurn ? newAttempt(now) : null;
    appendMessage(tx, courseId, questionId, sequence, {
      role: "student",
      text,
      authorUid: actor.principal.uid,
      referencedKnowledgeIds: [],
      lowConfidence: false,
      createdAt: now,
    });
    tx.update(questionRef(courseId, questionId), {
      messageCount: sequence,
      status: nextStatus,
      ...(attempt ? { aiAttempt: attempt, lastErrorCode: null } : {}),
      updatedAt: now,
    });
    return attempt ? { courseId, questionId, attemptId: attempt.id, firstTurn: false } : null;
  });
  return { thread: await readStudentThread(courseId, questionId), aiTurn: ticket };
}

async function retryAiTurn(
  actor: CourseActor,
  courseId: string,
  questionId: string,
): Promise<{ thread: StudentThreadDetailDTO; aiTurn: AiTurnTicket }> {
  assertStudent(actor, courseId);
  const now = Timestamp.now();
  const ticket = await db().runTransaction(async (tx) => {
    const question = await readQuestion(tx, courseId, questionId);
    assertOwner(actor, courseId, question);
    unwrap(decideAiRetry(threadState(question, now.toMillis()), now.toMillis()));
    const attempt = newAttempt(now);
    tx.update(questionRef(courseId, questionId), {
      status: "pending",
      aiAttempt: attempt,
      lastErrorCode: null,
      updatedAt: now,
    });
    return { courseId, questionId, attemptId: attempt.id, firstTurn: question.categoryIds.length === 0 };
  });
  return { thread: await readStudentThread(courseId, questionId), aiTurn: ticket };
}

async function assertCurrentAttempt(tx: Transaction | null, ticket: AiTurnTicket): Promise<Question | null> {
  const ref = questionRef(ticket.courseId, ticket.questionId);
  const snap = tx ? await tx.get(ref) : await ref.get();
  if (!snap.exists) throw notFound();
  const question = questionSchema.parse(snap.data());
  return question.aiAttempt?.id === ticket.attemptId && question.status === "pending" ? question : null;
}

/** AI に渡す会話・カテゴリ。試行が古ければ conflict。 */
async function getAiTurnContext(ticket: AiTurnTicket): Promise<AiTurnContext> {
  const question = await assertCurrentAttempt(null, ticket);
  if (!question || isRawAiTurnExpired(question, Timestamp.now())) throw conflict();
  const course = await readCourse(null, ticket.courseId);
  const { messages } = await readThreadMessages(ticket.courseId, ticket.questionId, question);
  const currentMessages = messages.length > AI_CONTEXT_MAX_MESSAGES
    ? [messages[0], ...messages.slice(-(AI_CONTEXT_MAX_MESSAGES - 1))]
    : messages;
  const available = AI_CONTEXT_MAX_MESSAGES - currentMessages.length;
  const context = question.relatedQuestion?.messages ?? [];
  const inherited = available > 0 ? context.slice(-available).map((message, index) => ({ ...message, id: `related-${index}` })) : [];
  const combined = [...inherited, ...currentMessages].map((message, index) => ({ ...message, sequence: index + 1 }));
  return {
    messages: combined,
    categories: sortedCategories(course),
    categoryIds: question.categoryIds,
    firstMessageText: messages[0]?.text ?? "",
    needsTitle: isQuestionExcerpt(question.title),
  };
}

/** 初回分類の結果を、講義の現行カテゴリと照合して保存する（最大2件、有効なものがなければ other）。 */
async function setAiCategories(ticket: AiTurnTicket, candidateIds: readonly string[], title?: string): Promise<string[]> {
  return db().runTransaction(async (tx) => {
    const question = await assertCurrentAttempt(tx, ticket);
    if (!question || isRawAiTurnExpired(question, Timestamp.now())) throw conflict();
    const course = await readCourse(tx, ticket.courseId);
    const categoryIds = normalizeCategoryIds(
      candidateIds,
      course.categories.map((c) => c.id),
      MAX_QUESTION_CATEGORIES,
    );
    const generatedTitle = ticket.firstTurn || isQuestionExcerpt(question.title) ? generatedQuestionTitle(title, question.title) : undefined;
    tx.update(questionRef(ticket.courseId, ticket.questionId), {
      categoryIds,
      ...(generatedTitle ? { title: generatedTitle } : {}),
    });
    return categoryIds;
  });
}

/** 回答に渡す公開Q&A（同じ講義・カテゴリ一致・新しい順に最大30件）。教員確認済みのものだけが入っている。 */
async function listKnowledgeForAnswer(courseId: string, categoryIds: string[]): Promise<PublishedKnowledgeDTO[]> {
  if (categoryIds.length === 0) return [];
  return queryPublishedKnowledge(courseId, categoryIds, KNOWLEDGE_FOR_ANSWER_LIMIT);
}

/** AI の回答を保存する。古い試行・期限（90秒）を過ぎた試行の結果は保存せず applied=false を返す。 */
async function finishAiTurn(ticket: AiTurnTicket, answer: AiAnswer): Promise<{ applied: boolean }> {
  const text = answer.text.trim();
  if (!text) return failAiTurn(ticket, "empty_answer");
  const now = Timestamp.now();
  return db().runTransaction(async (tx) => {
    const question = await assertCurrentAttempt(tx, ticket);
    if (!question) return { applied: false };
    // 期限を過ぎて届いた回答は保存しない。保存済みの発言は残し、失敗（error）として閉じて再試行できるようにする。
    if (isRawAiTurnExpired(question, now)) {
      tx.update(questionRef(ticket.courseId, ticket.questionId), { ...closeExpiredAiTurn(question, now), updatedAt: now });
      return { applied: false };
    }
    const sequence = question.messageCount + 1;
    appendMessage(tx, ticket.courseId, ticket.questionId, sequence, {
      role: "assistant",
      text: text.slice(0, AI_ANSWER_MAX_LENGTH),
      authorUid: null,
      referencedKnowledgeIds: [...new Set(answer.referencedKnowledgeIds)],
      lowConfidence: answer.escalate,
      createdAt: now,
    });
    tx.update(questionRef(ticket.courseId, ticket.questionId), {
      messageCount: sequence,
      status: answer.escalate ? "escalated" : "ai_answered",
      escalatedBy: answer.escalate ? "ai" : question.escalatedBy,
      aiAttempt: null,
      lastErrorCode: null,
      updatedAt: now,
    });
    return { applied: true };
  });
}

/** AI の失敗を記録する。保存済みの発言は残し、生徒が再試行できる状態（error）にする。 */
async function failAiTurn(ticket: AiTurnTicket, errorCode: string): Promise<{ applied: boolean }> {
  const now = Timestamp.now();
  return db().runTransaction(async (tx) => {
    const question = await assertCurrentAttempt(tx, ticket);
    if (!question) return { applied: false };
    tx.update(questionRef(ticket.courseId, ticket.questionId), {
      status: "error",
      aiAttempt: null,
      lastErrorCode: errorCode.slice(0, 64),
      updatedAt: now,
    });
    return { applied: true };
  });
}

async function escalateQuestion(
  actor: CourseActor,
  courseId: string,
  questionId: string,
): Promise<StudentThreadDetailDTO> {
  assertStudent(actor, courseId);
  const now = Timestamp.now();
  await db().runTransaction(async (tx) => {
    const question = await readQuestion(tx, courseId, questionId);
    assertOwner(actor, courseId, question);
    unwrap(decideEscalate(threadState(question, now.toMillis())));
    tx.update(questionRef(courseId, questionId), {
      ...closeExpiredAiTurn(question, now),
      status: "escalated",
      escalatedBy: "student",
      updatedAt: now,
    });
  });
  return readStudentThread(courseId, questionId);
}

async function replyToQuestion(
  actor: CourseActor,
  courseId: string,
  questionId: string,
  input: { text: unknown },
): Promise<TeacherThreadDetailDTO> {
  assertTeacher(actor, courseId);
  const text = parseText(input.text);
  const now = Timestamp.now();
  await db().runTransaction(async (tx) => {
    const question = await readQuestion(tx, courseId, questionId);
    unwrap(decideTeacherReply(threadState(question, now.toMillis())));
    const sequence = question.messageCount + 1;
    appendMessage(tx, courseId, questionId, sequence, {
      role: "teacher",
      text,
      authorUid: actor.principal.uid,
      referencedKnowledgeIds: [],
      lowConfidence: false,
      createdAt: now,
    });
    tx.update(questionRef(courseId, questionId), { messageCount: sequence, status: "teacher_answered", updatedAt: now });
    const notificationId = createHash("sha256").update(`${questionId}:${sequence}`).digest("hex");
    tx.create(notificationsCol(courseId, question.studentId).doc(notificationId), {
      questionId, messageId: String(sequence).padStart(6, "0"), title: question.title, createdAt: now, readAt: null,
    });
  });
  return readTeacherThread(courseId, questionId);
}

// ---------------------------------------------------------------------------
// 解決と共有候補の生成
// ---------------------------------------------------------------------------

/** 要約生成1回分の試行。messages は生成時点で確定した会話（自信のない AI 回答は除く）。 */
export type DraftGenerationTicket = {
  courseId: string;
  questionId: string;
  generationId: string;
  messages: MessageDTO[];
};

type Reservation = { generationId: string; untilSequence: number };

/**
 * トランザクション内で要約生成を1つ予約する。候補がなければ作る。
 * 期限切れの生成中があれば失敗扱いにして置き換える。既存の版・公開状態は変えない。
 * 呼び出し側は事前に tx.get で question と draft を読んでおくこと（読み取り→書き込みの順を守る）。
 */
function reserveGeneration(
  tx: Transaction,
  courseId: string,
  questionId: string,
  question: Question,
  draft: Draft | null,
  options: { reason: DraftGenerationReason; requestedBy: "student" | "teacher"; uid: string; now: Timestamp },
  questionPatch: Record<string, unknown> = {},
): Reservation {
  const { now } = options;
  const generationId = randomUUID();
  const untilSequence = question.messageCount;
  const ref: DraftGenerationRef = {
    id: generationId,
    reason: options.reason,
    requestedBy: options.requestedBy,
    status: "running",
    untilSequence,
    startedAt: now,
    expiresAt: after(now, DRAFT_GENERATION_TIMEOUT_MS),
    finishedAt: null,
  };
  let lastGeneration = draft?.lastGeneration ?? null;
  const stale = draft?.activeGeneration;
  if (stale) {
    // decide* で期限切れであることを確認済み。古い試行を失敗として閉じる。
    lastGeneration = { ...stale, status: "failed", finishedAt: now };
    tx.update(generationsCol(courseId, questionId).doc(stale.id), {
      status: "failed",
      finishedAt: now,
      errorCode: "expired",
    });
  }
  const next: Draft = draft
    ? { ...draft, activeGeneration: ref, lastGeneration, updatedAt: now }
    : {
        publication: "none",
        categoryId: question.categoryIds[0] ?? "other",
        selectedVersionId: null,
        selectedQuestion: null,
        versionCount: 0,
        activeGeneration: ref,
        lastGeneration: null,
        publishedVersionId: null,
        publishedKnowledgeId: null,
        questionResolved: !!question.resolvedAt,
        createdAt: now,
        updatedAt: now,
      };
  if (questionPatch.resolvedAt) next.questionResolved = true;
  tx.set(draftRef(courseId, questionId), next);
  tx.create(generationsCol(courseId, questionId).doc(generationId), {
    ...ref,
    requestedByUid: options.uid,
    versionId: null,
    errorCode: null,
  });
  tx.update(questionRef(courseId, questionId), {
    ...questionPatch,
    draft: mirrorRecordFromDraft(next),
    updatedAt: now,
  });
  return { generationId, untilSequence };
}

async function ticketFor(courseId: string, questionId: string, reservation: Reservation): Promise<DraftGenerationTicket> {
  // sequence が確定した発言は変更されないので、トランザクションの外で読んでも同じ内容になる。
  // 自信がなく先生へ引き継いだ AI 回答は共有候補の素材に入れない。
  const snap = await messagesCol(courseId, questionId)
    .where("sequence", "<=", reservation.untilSequence)
    .orderBy("sequence")
    .get();
  const messages = snap.docs
    .map((doc) => ({ id: doc.id, message: messageSchema.parse(doc.data()) }))
    .filter(({ message }) => !(message.role === "assistant" && message.lowConfidence))
    .map(({ id, message }) => toMessageDTO(id, message));
  if (messages.length <= AI_CONTEXT_MAX_MESSAGES) {
    return { courseId, questionId, generationId: reservation.generationId, messages };
  }
  const recent = messages.slice(-(AI_CONTEXT_MAX_MESSAGES - 1));
  // 対応待ちの補足が続いても、要約の根拠となる回答を落とさない。
  if (recent.every((message) => message.role === "student")) {
    const latestAnswer = messages.findLast((message) => message.role !== "student");
    if (latestAnswer) recent[0] = latestAnswer;
  }
  return { courseId, questionId, generationId: reservation.generationId, messages: [messages[0], ...recent] };
}

/**
 * 生徒の「解決した」。resolvedAt の記録と要約生成の予約を1つのトランザクションで行う
 * （途中で失敗しても「解決したのに候補の予約がない」状態にならない）。
 * 解決済みへの再送は何もせず generation=null を返す。
 */
async function resolveQuestion(
  actor: CourseActor,
  courseId: string,
  questionId: string,
): Promise<{ thread: StudentThreadDetailDTO; generation: DraftGenerationTicket | null }> {
  assertStudent(actor, courseId);
  const now = Timestamp.now();
  const reservation = await db().runTransaction(async (tx) => {
    const question = await readQuestion(tx, courseId, questionId);
    const draft = await readDraftOrNull(tx, courseId, questionId);
    assertOwner(actor, courseId, question);
    const { alreadyResolved } = unwrap(decideResolve(threadState(question, now.toMillis()), now.toMillis()));
    if (alreadyResolved) return null;
    const questionPatch = { ...closeExpiredAiTurn(question, now), resolvedAt: now };
    if (!await hasSummaryAnswer(tx, courseId, questionId)) {
      if (draft) {
        const stale = draft.activeGeneration;
        const next: Draft = { ...draft, questionResolved: true, activeGeneration: null, updatedAt: now,
          publication: draft.publication === "published" ? "published" : "dismissed" };
        if (stale) {
          next.lastGeneration = { ...stale, status: "failed", finishedAt: now };
          tx.update(generationsCol(courseId, questionId).doc(stale.id), { status: "failed", finishedAt: now, errorCode: "expired" });
        }
        tx.set(draftRef(courseId, questionId), next);
        Object.assign(questionPatch, { draft: mirrorRecordFromDraft(next) });
      }
      tx.update(questionRef(courseId, questionId), { ...questionPatch, sharingExcluded: true, updatedAt: now });
      return null;
    }
    return reserveGeneration(
      tx,
      courseId,
      questionId,
      question,
      draft,
      { reason: "resolve", requestedBy: "student", uid: actor.principal.uid, now },
      { ...questionPatch, sharingExcluded: false },
    );
  });
  return {
    thread: await readStudentThread(courseId, questionId),
    generation: reservation ? await ticketFor(courseId, questionId, reservation) : null,
  };
}

/**
 * 候補の作成・再生成の要求（本人または担当教員）。教員の作成でも相談は解決済みにしない。
 * mode=retry は直前の生成が失敗したときの再試行、regenerate は新しい別案。
 * 戻り値の thread は生徒には生徒用、教員には教員用の DTO。候補の本文は含まない。
 */
async function requestDraftGeneration(
  actor: CourseActor,
  courseId: string,
  questionId: string,
  input: { mode?: "regenerate" | "retry" } = {},
): Promise<{ generation: DraftGenerationTicket; summaryStatus: SummaryStatus }> {
  const mode = input.mode === "retry" ? "retry" : "regenerate";
  const now = Timestamp.now();
  const reservation = await db().runTransaction(async (tx) => {
    const question = await readQuestion(tx, courseId, questionId);
    const draft = await readDraftOrNull(tx, courseId, questionId);
    const teacher = canActAsTeacher(actor, courseId);
    if (!teacher) assertOwner(actor, courseId, question);
    const requestedBy = teacher ? "teacher" : "student";
    const { reason } = unwrap(decideGenerationRequest(threadState(question, now.toMillis()), requestedBy, mode, now.toMillis()));
    await assertSharingAllowed(tx, courseId, questionId, question);
    return reserveGeneration(
      tx,
      courseId,
      questionId,
      question,
      draft,
      { reason, requestedBy, uid: actor.principal.uid, now },
      closeExpiredAiTurn(question, now),
    );
  });
  return { generation: await ticketFor(courseId, questionId, reservation), summaryStatus: "generating" };
}

function cleanDraftField(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && Array.from(trimmed).length <= max ? trimmed : null;
}

/** 要約結果を新しい版として保存する。教員編集版・選択中の版・公開本文は上書きしない。 */
async function finishDraftGeneration(
  ticket: Pick<DraftGenerationTicket, "courseId" | "questionId" | "generationId">,
  output: { question: string; answer: string },
): Promise<{ applied: boolean }> {
  const question = cleanDraftField(output.question, DRAFT_QUESTION_MAX_LENGTH);
  const answer = cleanDraftField(output.answer, DRAFT_ANSWER_MAX_LENGTH);
  if (!question || !answer) return failDraftGeneration(ticket, "invalid_output");
  const { courseId, questionId, generationId } = ticket;
  const now = Timestamp.now();
  return db().runTransaction(async (tx) => {
    const draft = await readDraftOrNull(tx, courseId, questionId);
    const active = draft?.activeGeneration;
    if (!draft || active?.id !== generationId) return { applied: false };
    // 期限を過ぎた生成は、画面・再試行の判定と同じく失敗として閉じる（遅れて届いた結果は保存しない）。
    if (isExpired(active.expiresAt.toMillis(), now.toMillis())) {
      closeGenerationAsFailed(tx, courseId, questionId, draft, active, "expired", now);
      return { applied: false };
    }
    const thread = await readQuestion(tx, courseId, questionId);
    const generatedTitle = isQuestionExcerpt(thread.title) ? generatedQuestionTitle(question, thread.title) : undefined;
    const versionRef = versionsCol(courseId, questionId).doc();
    tx.create(versionRef, {
      kind: "generated",
      question,
      answer,
      categoryId: draft.categoryId,
      generationId,
      basedOnVersionId: null,
      untilSequence: active.untilSequence,
      createdByUid: null,
      createdAt: now,
    });
    const next: Draft = {
      ...draft,
      selectedVersionId: draft.selectedVersionId ?? versionRef.id,
      selectedQuestion: draft.selectedVersionId ? draft.selectedQuestion : question,
      versionCount: draft.versionCount + 1,
      activeGeneration: null,
      lastGeneration: { ...active, status: "succeeded", finishedAt: now },
      updatedAt: now,
    };
    tx.set(draftRef(courseId, questionId), next);
    tx.update(generationsCol(courseId, questionId).doc(generationId), {
      status: "succeeded",
      finishedAt: now,
      versionId: versionRef.id,
    });
    tx.update(questionRef(courseId, questionId), {
      draft: mirrorRecordFromDraft(next), updatedAt: now,
      ...(generatedTitle ? { title: generatedTitle } : {}),
    });
    return { applied: true };
  });
}

/** 要約の失敗を記録する。会話・解決日時・既存の版・公開本文は変えない。 */
async function failDraftGeneration(
  ticket: Pick<DraftGenerationTicket, "courseId" | "questionId" | "generationId">,
  errorCode: string,
): Promise<{ applied: boolean }> {
  const { courseId, questionId, generationId } = ticket;
  const now = Timestamp.now();
  return db().runTransaction(async (tx) => {
    const draft = await readDraftOrNull(tx, courseId, questionId);
    const active = draft?.activeGeneration;
    if (!draft || active?.id !== generationId) return { applied: false };
    closeGenerationAsFailed(tx, courseId, questionId, draft, active, errorCode, now);
    return { applied: true };
  });
}

/** 実行中の生成を失敗として閉じる。会話・解決日時・既存の版・公開本文は変えない。 */
function closeGenerationAsFailed(
  tx: Transaction,
  courseId: string,
  questionId: string,
  draft: Draft,
  active: DraftGenerationRef,
  errorCode: string,
  now: Timestamp,
) {
  const next: Draft = {
    ...draft,
    activeGeneration: null,
    lastGeneration: { ...active, status: "failed", finishedAt: now },
    updatedAt: now,
  };
  tx.set(draftRef(courseId, questionId), next);
  tx.update(generationsCol(courseId, questionId).doc(active.id), {
    status: "failed",
    finishedAt: now,
    errorCode: errorCode.slice(0, 64),
  });
  tx.update(questionRef(courseId, questionId), { draft: mirrorRecordFromDraft(next), updatedAt: now });
}

// ---------------------------------------------------------------------------
// 共有候補の確認・編集・公開（担当教員）
// ---------------------------------------------------------------------------

async function listDrafts(
  actor: CourseActor,
  courseId: string,
  options: { publication?: Draft["publication"][]; statuses?: SummaryStatus[] } = {},
): Promise<KnowledgeDraftListDTO[]> {
  assertTeacher(actor, courseId);
  const publication = options.publication?.length ? options.publication : ["none"];
  const snap = await courseRef(courseId).collection("knowledgeDrafts")
    .where("publication", "in", publication)
    .orderBy("updatedAt", "desc")
    .limit(200)
    .get();
  const nowMs = Date.now();
  const items = snap.docs.map((doc) => toDraftListItem(doc.id, draftSchema.parse(doc.data()), nowMs));
  return options.statuses?.length ? items.filter((item) => options.statuses?.includes(item.status)) : items;
}

async function readDraft(actor: CourseActor, courseId: string, questionId: string): Promise<KnowledgeDraftDTO> {
  assertTeacher(actor, courseId);
  const snap = await draftRef(courseId, questionId).get();
  if (!snap.exists) throw notFound();
  const draft = draftSchema.parse(snap.data());
  const versions = await versionsCol(courseId, questionId).orderBy("createdAt").get();
  return toDraftDTO(
    questionId,
    draft,
    versions.docs.map((doc) => toDraftVersionDTO(doc.id, draftVersionSchema.parse(doc.data()))),
    Date.now(),
  );
}

type DraftContent = { question: unknown; answer: unknown; categoryId: unknown };

function parseDraftContent(input: DraftContent, course: Course) {
  const question = cleanDraftField(input.question, DRAFT_QUESTION_MAX_LENGTH);
  const answer = cleanDraftField(input.answer, DRAFT_ANSWER_MAX_LENGTH);
  if (!question) throw invalidInput(`質問は1〜${DRAFT_QUESTION_MAX_LENGTH}文字で入力してください。`);
  if (!answer) throw invalidInput(`回答は1〜${DRAFT_ANSWER_MAX_LENGTH}文字で入力してください。`);
  if (typeof input.categoryId !== "string" || !course.categories.some((c) => c.id === input.categoryId)) {
    throw invalidInput("講義に登録されたカテゴリを選んでください。");
  }
  return { question, answer, categoryId: input.categoryId };
}

async function readVersion(tx: Transaction, courseId: string, questionId: string, versionId: unknown) {
  if (typeof versionId !== "string") throw invalidInput("版を指定してください。");
  const snap = await tx.get(versionsCol(courseId, questionId).doc(parseId(versionId)));
  if (!snap.exists) throw notFound();
  return { id: snap.id, version: draftVersionSchema.parse(snap.data()) };
}

function assertEditable(draft: Draft) {
  // 公開後の改訂・見送り後の再開は B 担当が操作を決めるまで受け付けない。
  if (draft.publication !== "none") throw conflict("公開済み・見送り済みの候補は編集できません。");
}

function assertExpectedSelection(draft: Draft, expected: unknown) {
  if (expected !== undefined && expected !== draft.selectedVersionId) {
    throw conflict("ほかの先生が候補を更新しました。最新の内容を読み込んでください。");
  }
}

/**
 * 教員の編集を新しい教員編集版として保存し、選択中にする。
 * expectedSelectedVersionId を渡すと、開いた時点から選択中の版が変わっていれば conflict（並行編集の検知）。
 */
async function saveDraftEdit(
  actor: CourseActor,
  courseId: string,
  questionId: string,
  input: DraftContent & { baseVersionId: unknown; expectedSelectedVersionId?: unknown },
): Promise<KnowledgeDraftDTO> {
  assertTeacher(actor, courseId);
  const now = Timestamp.now();
  await db().runTransaction(async (tx) => {
    const course = await readCourse(tx, courseId);
    const draft = await readDraftOrNull(tx, courseId, questionId);
    if (!draft) throw notFound();
    const base = await readVersion(tx, courseId, questionId, input.baseVersionId);
    assertEditable(draft);
    assertExpectedSelection(draft, input.expectedSelectedVersionId);
    const content = parseDraftContent(input, course);
    const versionRef = versionsCol(courseId, questionId).doc();
    tx.create(versionRef, {
      kind: "teacher_edit",
      ...content,
      generationId: null,
      basedOnVersionId: base.id,
      untilSequence: null,
      createdByUid: actor.principal.uid,
      createdAt: now,
    });
    const next: Draft = {
      ...draft,
      categoryId: content.categoryId,
      selectedVersionId: versionRef.id,
      selectedQuestion: content.question,
      versionCount: draft.versionCount + 1,
      updatedAt: now,
    };
    tx.set(draftRef(courseId, questionId), next);
    tx.update(questionRef(courseId, questionId), { draft: mirrorRecordFromDraft(next), updatedAt: now });
  });
  return readDraft(actor, courseId, questionId);
}

/** 別案など、既存の版を選択中にする（内容は変えない）。 */
async function selectDraftVersion(
  actor: CourseActor,
  courseId: string,
  questionId: string,
  input: { versionId: unknown; expectedSelectedVersionId?: unknown },
): Promise<KnowledgeDraftDTO> {
  assertTeacher(actor, courseId);
  const now = Timestamp.now();
  await db().runTransaction(async (tx) => {
    const draft = await readDraftOrNull(tx, courseId, questionId);
    if (!draft) throw notFound();
    const { id, version } = await readVersion(tx, courseId, questionId, input.versionId);
    assertEditable(draft);
    assertExpectedSelection(draft, input.expectedSelectedVersionId);
    tx.update(draftRef(courseId, questionId), {
      selectedVersionId: id,
      selectedQuestion: version.question,
      categoryId: version.categoryId,
      updatedAt: now,
    });
  });
  return readDraft(actor, courseId, questionId);
}

const sameContent = (a: { question: string; answer: string; categoryId: string }, b: typeof a) =>
  a.question === b.question && a.answer === b.answer && a.categoryId === b.categoryId;

/**
 * 教員の確認操作による公開。表示中の内容（編集後）と元にした版を受け取る。
 * 内容が版と違えば教員編集版を作ってから公開する。同じ内容の再送は既存の結果を返し、別の内容は conflict。
 */
async function publishDraft(
  actor: CourseActor,
  courseId: string,
  questionId: string,
  input: DraftContent & { versionId: unknown },
): Promise<PublishedKnowledgeDTO> {
  assertTeacher(actor, courseId);
  const now = Timestamp.now();
  const knowledgeId = await db().runTransaction(async (tx) => {
    const course = await readCourse(tx, courseId);
    const draft = await readDraftOrNull(tx, courseId, questionId);
    if (!draft) throw notFound();
    const base = await readVersion(tx, courseId, questionId, input.versionId);
    const published = draft.publishedKnowledgeId
      ? await tx.get(knowledgeCol(courseId).doc(draft.publishedKnowledgeId))
      : null;
    const content = parseDraftContent(input, course);
    const publishedData = published?.exists ? knowledgeSchema.parse(published.data()) : null;
    const { alreadyPublished } = unwrap(
      decidePublish(draft.publication, !!publishedData && sameContent(publishedData, content)),
    );
    if (alreadyPublished && draft.publishedKnowledgeId) return draft.publishedKnowledgeId;
    await assertSharingAllowed(tx, courseId, questionId, await readQuestion(tx, courseId, questionId));

    let versionId = base.id;
    let versionCount = draft.versionCount;
    if (!sameContent(base.version, content)) {
      const editRef = versionsCol(courseId, questionId).doc();
      tx.create(editRef, {
        kind: "teacher_edit",
        ...content,
        generationId: null,
        basedOnVersionId: base.id,
        untilSequence: null,
        createdByUid: actor.principal.uid,
        createdAt: now,
      });
      versionId = editRef.id;
      versionCount += 1;
    }
    const knowledgeRef = knowledgeCol(courseId).doc();
    const knowledge: Knowledge = {
      ...content,
      publishedAt: now,
      publishedByUid: actor.principal.uid,
      sourceQuestionId: questionId,
      sourceVersionId: versionId,
      createdAt: now,
      updatedAt: now,
    };
    tx.create(knowledgeRef, knowledge);
    const next: Draft = {
      ...draft,
      publication: "published",
      categoryId: content.categoryId,
      selectedVersionId: versionId,
      selectedQuestion: content.question,
      versionCount,
      publishedVersionId: versionId,
      publishedKnowledgeId: knowledgeRef.id,
      updatedAt: now,
    };
    tx.set(draftRef(courseId, questionId), next);
    tx.update(questionRef(courseId, questionId), { draft: mirrorRecordFromDraft(next), updatedAt: now });
    return knowledgeRef.id;
  });
  const snap = await knowledgeCol(courseId).doc(knowledgeId).get();
  // 公開の直後に別の要求で取り下げられた場合（同じ内容の再送が既存の結果を返した直後など）は、最新の状態を読み直させる。
  if (!snap.exists) throw conflict();
  return toPublishedKnowledge(snap.id, knowledgeSchema.parse(snap.data()));
}

async function dismissDraft(
  actor: CourseActor,
  courseId: string,
  questionId: string,
): Promise<{ questionId: string; status: "dismissed" }> {
  assertTeacher(actor, courseId);
  const now = Timestamp.now();
  await db().runTransaction(async (tx) => {
    const draft = await readDraftOrNull(tx, courseId, questionId);
    if (!draft) throw notFound();
    const { alreadyDismissed } = unwrap(decideDismiss(draft.publication));
    if (alreadyDismissed) return;
    const next: Draft = { ...draft, publication: "dismissed", updatedAt: now };
    tx.set(draftRef(courseId, questionId), next);
    tx.update(questionRef(courseId, questionId), { draft: mirrorRecordFromDraft(next), updatedAt: now });
  });
  return { questionId, status: "dismissed" };
}

/**
 * 見送った候補を確認待ちに戻す（担当教員だけ）。版・本文・カテゴリ・選択中の版は残し、AI は呼ばない。
 * 生成中・確認できる版がない・公開中は 409、候補がなければ 404。すでに確認待ちなら何もせず同じ形で返す。
 * 期限切れのまま残っている生成は、失敗（expired）として同じトランザクションで閉じる。
 */
async function restoreDraft(actor: CourseActor, courseId: string, questionId: string): Promise<KnowledgeDraftListDTO> {
  assertTeacher(actor, courseId);
  const now = Timestamp.now();
  await db().runTransaction(async (tx) => {
    const draft = await readDraftOrNull(tx, courseId, questionId);
    if (!draft) throw notFound();
    const question = await readQuestion(tx, courseId, questionId);
    await assertSharingAllowed(tx, courseId, questionId, question);
    const mirror = mirrorFromRecord(mirrorRecordFromDraft(draft));
    if (!mirror) throw notFound();
    const { alreadyPending } = unwrap(decideRestore(mirror, now.toMillis()));
    if (alreadyPending) return;
    let next: Draft = { ...draft, publication: "none", updatedAt: now };
    const stale = draft.activeGeneration;
    if (stale) {
      next = { ...next, activeGeneration: null, lastGeneration: { ...stale, status: "failed", finishedAt: now } };
      tx.update(generationsCol(courseId, questionId).doc(stale.id), { status: "failed", finishedAt: now, errorCode: "expired" });
    }
    tx.set(draftRef(courseId, questionId), next);
    tx.update(questionRef(courseId, questionId), { draft: mirrorRecordFromDraft(next), updatedAt: now });
  });
  const snap = await draftRef(courseId, questionId).get();
  return toDraftListItem(questionId, draftSchema.parse(snap.data()), Date.now());
}

/** 教員画面の共有済みQ&A（担当教員だけ）。公開用DTOの5項目だけを返す。 */
async function listTeacherKnowledge(actor: CourseActor, courseId: string): Promise<PublishedKnowledgeDTO[]> {
  assertTeacher(actor, courseId);
  return queryPublishedKnowledge(courseId, undefined, 200);
}

/**
 * 公開Q&Aを取り下げる（担当教員だけ）。1つのトランザクションで、
 * knowledge を削除し、元候補を確認待ち（publication=none）に戻して公開していた版を選択し、公開中を示す値を空にする。
 * 版の履歴・相談の resolvedAt は変えない。再公開は publishDraft で新しい knowledge ID を発行する。
 * - 取り下げ済み（存在しない）ID は 404。
 * - 元候補がない Q&A（シードで直接入れた初期データなど）は削除だけ行う（questionId=null）。
 * - 元候補の現在の公開と一致しない（取り下げ後に再公開された別の Q&A など）は 409 で、何も変えない。
 * - 元候補で別案を生成中でも取り下げられる（生成が終わると別案が増える）。
 */
async function unpublishKnowledge(
  actor: CourseActor,
  courseId: string,
  knowledgeId: string,
): Promise<UnpublishKnowledgeResultDTO> {
  assertTeacher(actor, courseId);
  const id = parseId(knowledgeId);
  const now = Timestamp.now();
  const questionId = await db().runTransaction(async (tx) => {
    const knowledgeRef = knowledgeCol(courseId).doc(id);
    const knowledgeSnap = await tx.get(knowledgeRef);
    if (!knowledgeSnap.exists) throw notFound();
    const knowledge = knowledgeSchema.parse(knowledgeSnap.data());
    const sourceId = documentId.safeParse(knowledge.sourceQuestionId).success ? knowledge.sourceQuestionId : null;
    const draft = sourceId ? await readDraftOrNull(tx, courseId, sourceId) : null;
    const { restoreDraft: restore } = unwrap(decideUnpublish(draft, id));
    const publishedVersionId = draft?.publishedVersionId ?? knowledge.sourceVersionId;
    const versionSnap = restore && sourceId && documentId.safeParse(publishedVersionId).success
      ? await tx.get(versionsCol(courseId, sourceId).doc(publishedVersionId))
      : null;
    tx.delete(knowledgeRef);
    if (!restore || !draft || !sourceId) return null;
    const version = versionSnap?.exists ? draftVersionSchema.parse(versionSnap.data()) : null;
    const next: Draft = {
      ...draft,
      publication: "none",
      publishedKnowledgeId: null,
      publishedVersionId: null,
      ...(version && versionSnap
        ? { selectedVersionId: versionSnap.id, selectedQuestion: version.question, categoryId: version.categoryId }
        : {}),
      updatedAt: now,
    };
    tx.set(draftRef(courseId, sourceId), next);
    tx.update(questionRef(courseId, sourceId), { draft: mirrorRecordFromDraft(next), updatedAt: now });
    return sourceId;
  });
  return { knowledgeId: id, status: "unpublished", questionId };
}

// ---------------------------------------------------------------------------
// カテゴリ（担当教員が追加・編集。削除は未合意）
// ---------------------------------------------------------------------------

function parseCategoryName(value: unknown): string {
  const name = cleanDraftField(value, CATEGORY_NAME_MAX_LENGTH);
  if (!name) throw invalidInput(`カテゴリ名は1〜${CATEGORY_NAME_MAX_LENGTH}文字で入力してください。`);
  return name;
}

async function addCategory(
  actor: CourseActor,
  courseId: string,
  input: { name: unknown },
): Promise<CourseCategory[]> {
  assertTeacher(actor, courseId);
  const name = parseCategoryName(input.name);
  const now = Timestamp.now();
  return db().runTransaction(async (tx) => {
    const course = await readCourse(tx, courseId);
    if (course.categories.some((c) => c.name === name)) throw conflict("同じ名前のカテゴリがあります。");
    const order = Math.max(0, ...course.categories.map((c) => c.order)) + 1;
    const categories = [...course.categories, { id: `cat-${randomUUID().slice(0, 8)}`, name, order }];
    tx.update(courseRef(courseId), { categories, updatedAt: now });
    return [...categories].sort((a, b) => a.order - b.order);
  });
}

async function updateCategory(
  actor: CourseActor,
  courseId: string,
  categoryId: string,
  input: { name?: unknown; order?: unknown },
): Promise<CourseCategory[]> {
  assertTeacher(actor, courseId);
  const name = input.name === undefined ? undefined : parseCategoryName(input.name);
  if (input.order !== undefined && (typeof input.order !== "number" || !Number.isFinite(input.order))) {
    throw invalidInput("並び順は数値で指定してください。");
  }
  const order = input.order as number | undefined;
  const now = Timestamp.now();
  return db().runTransaction(async (tx) => {
    const course = await readCourse(tx, courseId);
    if (!course.categories.some((c) => c.id === categoryId)) throw notFound();
    if (name && course.categories.some((c) => c.name === name && c.id !== categoryId)) {
      throw conflict("同じ名前のカテゴリがあります。");
    }
    const categories = course.categories.map((c) =>
      c.id === categoryId ? { ...c, ...(name ? { name } : {}), ...(order !== undefined ? { order } : {}) } : c,
    );
    tx.update(courseRef(courseId), { categories, updatedAt: now });
    return [...categories].sort((a, b) => a.order - b.order);
  });
}

// ---------------------------------------------------------------------------
// 招待と講義参加
// ---------------------------------------------------------------------------

export function inviteCodeHash(courseId: string, normalizedCode: string): string {
  return createHash("sha256").update(`${courseId}:${normalizedCode}`).digest("hex");
}

function generateInviteCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  // 256 は 31 の倍数でないため、偏りを避けて棄却サンプリングする。
  for (let i = 0; code.length < 8; i++) {
    const byte = i < bytes.length ? bytes[i] : randomBytes(1)[0];
    if (byte < 248) code += INVITE_ALPHABET[byte % INVITE_ALPHABET.length];
  }
  return code;
}

/** 招待を発行・再発行する。有効な旧招待はすべて失効させる（参加済みの生徒には影響しない）。 */
async function issueInvite(actor: CourseActor, courseId: string): Promise<InviteDTO> {
  assertTeacher(actor, courseId);
  const code = generateInviteCode();
  const now = Timestamp.now();
  const expiresAt = after(now, INVITE_DURATION_MS);
  await db().runTransaction(async (tx) => {
    await readCourse(tx, courseId);
    const active = await tx.get(invitesCol(courseId).where("active", "==", true));
    for (const doc of active.docs) tx.update(doc.ref, { active: false, revokedAt: now });
    const invite: Invite = { active: true, createdByUid: actor.principal.uid, createdAt: now, revokedAt: null, expiresAt };
    tx.create(invitesCol(courseId).doc(inviteCodeHash(courseId, code)), invite);
  });
  const formatted = formatInviteCode(code);
  return {
    code: formatted,
    joinPath: `/join/${encodeURIComponent(courseId)}`,
    issuedAt: now.toDate().toISOString(),
    expiresAt: expiresAt.toDate().toISOString(),
  };
}

const inactiveInvite = { active: false, issuedAt: null, expiresAt: null } satisfies InviteStatusDTO;

async function revokeInvites(actor: CourseActor, courseId: string): Promise<InviteStatusDTO> {
  assertTeacher(actor, courseId);
  const now = Timestamp.now();
  await db().runTransaction(async (tx) => {
    const active = await tx.get(invitesCol(courseId).where("active", "==", true));
    for (const doc of active.docs) tx.update(doc.ref, { active: false, revokedAt: now });
  });
  return inactiveInvite;
}

async function getInviteStatus(actor: CourseActor, courseId: string): Promise<InviteStatusDTO> {
  assertTeacher(actor, courseId);
  const snap = await invitesCol(courseId).where("active", "==", true).limit(1).get();
  const doc = snap.docs[0];
  if (!doc) return inactiveInvite;
  const { createdAt, expiresAt } = inviteSchema.parse(doc.data());
  if (!expiresAt || isExpired(expiresAt.toMillis(), Date.now())) return inactiveInvite;
  return { active: true, issuedAt: createdAt.toDate().toISOString(), expiresAt: expiresAt.toDate().toISOString() };
}

/** 講義に参加している生徒の人数（担当教員だけ）。集計クエリなので全員分のドキュメントは読まない。 */
async function countStudents(actor: CourseActor, courseId: string): Promise<number> {
  assertTeacher(actor, courseId);
  const snap = await courseRef(courseId).collection("enrollments").count().get();
  return snap.data().count;
}

const INVALID_INVITE = "共有IDまたは参加コードが正しくないか、コードが失効しています。";

/**
 * 招待を引き換えて講義に参加する（ログイン済みの本人だけ）。参加済みなら何もしない。
 * 講義が存在しない場合も同じエラーにして、講義IDの有無を推測できないようにする。
 */
async function redeemInvite(
  principal: Principal,
  courseId: string,
  input: { code: unknown },
): Promise<{ enrolled: true; alreadyEnrolled: boolean }> {
  const code = typeof input.code === "string" ? normalizeInviteCode(input.code) : null;
  const courseIdParsed = documentId.safeParse(courseId);
  if (!courseIdParsed.success) throw invalidInput(INVALID_INVITE);
  const enrollmentDoc = enrollmentRef(courseId, principal.uid);
  const attemptDoc = db().collection("inviteAttempts").doc(parseId(principal.uid));
  const result = await db().runTransaction(async (tx) => {
    const enrollment = await tx.get(enrollmentDoc);
    if (enrollment.exists) return { enrolled: true as const, alreadyEnrolled: true };

    const attemptSnap = await tx.get(attemptDoc);
    const attempt = attemptSnap.exists ? inviteAttemptSchema.parse(attemptSnap.data()) : null;
    const remainingMs = (attempt?.expiresAt.toMillis() ?? 0) - Date.now();
    const failures = remainingMs > 0 ? attempt?.count ?? 0 : 0;
    if (failures >= INVITE_MAX_FAILURES) return { retryAfterSeconds: Math.ceil(remainingMs / 1000) };

    const inviteSnap = code ? await tx.get(invitesCol(courseId).doc(inviteCodeHash(courseId, code))) : null;
    const now = Timestamp.now();
    if (inviteSnap?.exists) {
      const invite = inviteSchema.parse(inviteSnap.data());
      if (invite.active && invite.expiresAt && !isExpired(invite.expiresAt.toMillis(), now.toMillis())) {
        tx.create(enrollmentDoc, enrollmentSchema.parse({ uid: principal.uid, inviteId: inviteSnap.id, joinedAt: now }));
        return { enrolled: true as const, alreadyEnrolled: false };
      }
    }

    const count = failures + 1;
    tx.set(attemptDoc, { count, expiresAt: after(now, INVITE_ATTEMPT_WINDOW_MS) });
    return { retryAfterSeconds: count >= INVITE_MAX_FAILURES ? INVITE_ATTEMPT_WINDOW_MS / 1000 : 0 };
  });
  // 失敗回数の書き込みをコミットしてから HTTP エラーへ変換する。
  if (result.enrolled) return { enrolled: true, alreadyEnrolled: result.alreadyEnrolled };
  if (result.retryAfterSeconds) {
    const minutes = Math.ceil(result.retryAfterSeconds / 60);
    throw tooManyRequests(`参加コードの入力回数が上限に達しました。${minutes}分後にお試しください。`, result.retryAfterSeconds);
  }
  throw invalidInput(INVALID_INVITE);
}

/** 講義の参加・教員判定に使う生データ（src/server/auth/actor.ts 専用）。 */
export async function loadCourseMembership(courseId: string, uid: string) {
  const parsed = documentId.safeParse(courseId);
  if (!parsed.success) return null;
  const [courseSnap, enrollmentSnap] = await Promise.all([
    courseRef(courseId).get(),
    enrollmentRef(courseId, uid).get(),
  ]);
  if (!courseSnap.exists) return null;
  const course = courseSchema.parse(courseSnap.data());
  return { teacherEmails: course.teacherEmails, enrolled: enrollmentSnap.exists };
}

/** 講義一覧に必要な項目と、本人の参加レコードの有無だけを取得する。 */
export async function loadCourseMemberships(uid: string) {
  const database = db();
  const memberId = parseId(uid);
  const courses = await database.collection("courses").select("name", "teacherEmails").get();
  if (courses.empty) return [];
  const enrollments = await database.getAll(
    ...courses.docs.map((course) => course.ref.collection("enrollments").doc(memberId)),
    { fieldMask: [] },
  );
  const courseSummary = courseSchema.pick({ name: true, teacherEmails: true });
  const enrolledCourses = new Set(enrollments.filter((doc) => doc.exists).map((doc) => doc.ref.parent.parent?.id));
  return courses.docs.map((course) => ({
    id: course.id,
    ...courseSummary.parse(course.data()),
    enrolled: enrolledCourses.has(course.id),
  }));
}

/** A/B の Route Handler とサーバー処理が使う共通ストア。 */
export const workflowStore = {
  // 講義
  createCourse,
  getCourseView,
  getCourseViewer,
  // 読み出し
  readThread,
  listOwnThreads,
  listTeacherThreads,
  listPublishedKnowledge,
  readPublishedKnowledge,
  listNotifications,
  markNotificationRead,
  // 会話と AI（ticket 系は begin 系が返した試行だけを受け付ける）
  createQuestion,
  addStudentMessage,
  retryAiTurn,
  getAiTurnContext,
  setAiCategories,
  listKnowledgeForAnswer,
  finishAiTurn,
  failAiTurn,
  escalateQuestion,
  replyToQuestion,
  // 解決と候補の生成
  resolveQuestion,
  requestDraftGeneration,
  finishDraftGeneration,
  failDraftGeneration,
  // 候補の確認・編集・公開
  listDrafts,
  readDraft,
  saveDraftEdit,
  selectDraftVersion,
  publishDraft,
  dismissDraft,
  restoreDraft,
  listTeacherKnowledge,
  unpublishKnowledge,
  // カテゴリ
  addCategory,
  updateCategory,
  // 招待と参加
  issueInvite,
  revokeInvites,
  getInviteStatus,
  countStudents,
  redeemInvite,
};
