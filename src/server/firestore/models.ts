import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { messageRoles, questionStatuses } from "../../domain/course-workflow.ts";

// Firestore のレコード定義。画面・API にはそのまま返さず、src/server/firestore/dto.ts で DTO に変換する。
// パス：
//   courses/{courseId}
//   courses/{courseId}/enrollments/{uid}
//   courses/{courseId}/invites/{codeHash}
//   inviteAttempts/{uid}
//   courses/{courseId}/questions/{questionId}
//   courses/{courseId}/questions/{questionId}/messages/{sequence 6桁}
//   courses/{courseId}/knowledgeDrafts/{questionId}
//   courses/{courseId}/knowledgeDrafts/{questionId}/versions/{versionId}
//   courses/{courseId}/knowledgeDrafts/{questionId}/generations/{generationId}
//   courses/{courseId}/knowledge/{knowledgeId}

const ts = z.instanceof(Timestamp);

export const categorySchema = z.object({ id: z.string().min(1), name: z.string().min(1), order: z.number() });

export const courseSchema = z.object({
  name: z.string(),
  /** 担当教員の検証済みメール。新規作成時は作成者を登録する。 */
  teacherEmails: z.array(z.string()),
  categories: z.array(categorySchema),
  materials: z.array(z.object({ title: z.string(), storagePath: z.string() })).default([]),
  createdAt: ts,
  updatedAt: ts.optional(),
});

export const enrollmentSchema = z.object({
  uid: z.string().min(1),
  inviteId: z.string().min(1),
  joinedAt: ts,
});

export const inviteSchema = z.object({
  /** ドキュメントIDが講義IDとコードの SHA-256。生のコードは保存しない。 */
  active: z.boolean(),
  createdByUid: z.string(),
  createdAt: ts,
  revokedAt: ts.nullable(),
  /** 発行から30分。旧データの null は失効扱い。 */
  expiresAt: ts.nullable(),
});

export const inviteAttemptSchema = z.object({ count: z.int().positive(), expiresAt: ts });

const attemptSchema = z.object({ id: z.string().min(1), startedAt: ts, expiresAt: ts });

const relatedQuestionSchema = z.object({
  id: z.string(),
  title: z.string(),
  messages: z.array(z.object({ role: z.enum(messageRoles), text: z.string(), createdAt: z.string() })),
});

export const notificationSchema = z.object({
  questionId: z.string(),
  messageId: z.string(),
  title: z.string(),
  createdAt: ts,
  readAt: ts.nullable(),
});

export const draftMirrorSchema = z.object({
  generationRunning: z.boolean(),
  generationExpiresAt: ts.nullable(),
  lastGenerationFailed: z.boolean(),
  publication: z.enum(["none", "published", "dismissed"]),
  versionCount: z.number().int().min(0),
});

export const questionSchema = z.object({
  /** 検証済み uid。 */
  studentId: z.string().min(1),
  /** 相談作成時点の Google 表示名（なければ検証済みメール）。担当教員にだけ返す。 */
  studentDisplayName: z.string().nullable(),
  title: z.string(),
  categoryIds: z.array(z.string()).max(2),
  status: z.enum(questionStatuses),
  escalatedBy: z.enum(["ai", "student"]).nullable(),
  resolvedAt: ts.nullable(),
  sharingExcluded: z.boolean().optional(),
  messageCount: z.number().int().min(0),
  aiAttempt: attemptSchema.nullable(),
  lastErrorCode: z.string().nullable(),
  draft: draftMirrorSchema.nullable(),
  createdAt: ts,
  updatedAt: ts,
  relatedQuestion: relatedQuestionSchema.optional(),
});

export const messageSchema = z.object({
  role: z.enum(messageRoles),
  text: z.string(),
  sequence: z.number().int().min(1),
  authorUid: z.string().nullable(),
  referencedKnowledgeIds: z.array(z.string()),
  /** AI が自信がなく先生へ引き継いだ回答。共有候補の素材から除く。 */
  lowConfidence: z.boolean(),
  createdAt: ts,
});

const generationRefSchema = z.object({
  id: z.string().min(1),
  reason: z.enum(["resolve", "teacher_create", "regenerate", "retry"]),
  requestedBy: z.enum(["student", "teacher"]),
  status: z.enum(["running", "succeeded", "failed"]),
  untilSequence: z.number().int().min(1),
  startedAt: ts,
  expiresAt: ts,
  finishedAt: ts.nullable(),
});

export const draftSchema = z.object({
  // 一覧の状態（ready など）は読み出し時に src/server/workflow/rules.ts の summaryStatusOf で計算する。
  publication: z.enum(["none", "published", "dismissed"]),
  categoryId: z.string(),
  selectedVersionId: z.string().nullable(),
  /** 選択中の版の question（一覧のタイトル用の複製）。 */
  selectedQuestion: z.string().nullable(),
  versionCount: z.number().int().min(0),
  activeGeneration: generationRefSchema.nullable(),
  lastGeneration: generationRefSchema.nullable(),
  publishedVersionId: z.string().nullable(),
  publishedKnowledgeId: z.string().nullable(),
  questionResolved: z.boolean(),
  createdAt: ts,
  updatedAt: ts,
});

export const draftVersionSchema = z.object({
  kind: z.enum(["generated", "teacher_edit"]),
  question: z.string(),
  answer: z.string(),
  categoryId: z.string(),
  generationId: z.string().nullable(),
  basedOnVersionId: z.string().nullable(),
  untilSequence: z.number().int().nullable(),
  createdByUid: z.string().nullable(),
  createdAt: ts,
});

export const draftGenerationSchema = generationRefSchema.extend({
  requestedByUid: z.string(),
  versionId: z.string().nullable(),
  errorCode: z.string().nullable(),
});

export const knowledgeSchema = z.object({
  question: z.string(),
  answer: z.string(),
  categoryId: z.string(),
  publishedAt: ts,
  publishedByUid: z.string(),
  /** 内部参照。公開DTOには出さない。 */
  sourceQuestionId: z.string(),
  sourceVersionId: z.string(),
  createdAt: ts,
  updatedAt: ts,
});

export type Course = z.infer<typeof courseSchema>;
export type Enrollment = z.infer<typeof enrollmentSchema>;
export type Invite = z.infer<typeof inviteSchema>;
export type Question = z.infer<typeof questionSchema>;
export type DraftMirrorRecord = z.infer<typeof draftMirrorSchema>;
export type Message = z.infer<typeof messageSchema>;
export type Draft = z.infer<typeof draftSchema>;
export type DraftGenerationRef = z.infer<typeof generationRefSchema>;
export type DraftVersion = z.infer<typeof draftVersionSchema>;
export type DraftGeneration = z.infer<typeof draftGenerationSchema>;
export type Knowledge = z.infer<typeof knowledgeSchema>;
