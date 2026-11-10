// SDK に依存しない A〜D 共通の型。日時は API では ISO 8601 文字列。
// Firestore の Timestamp はサーバー内（src/server/firestore/）だけで扱う。

import type { AiAnswer } from "./ai-answer.ts";

export const questionStatuses = ["pending", "error", "ai_answered", "escalated", "teacher_answered"] as const;
export type QuestionStatus = (typeof questionStatuses)[number];

export const messageRoles = ["student", "assistant", "teacher"] as const;
export type MessageRole = (typeof messageRoles)[number];

/** 生徒・教員の画面に出す共有候補の要約状態。 */
export const summaryStatuses = ["none", "generating", "ready", "failed", "published", "dismissed"] as const;
export type SummaryStatus = (typeof summaryStatuses)[number];

export type EscalatedBy = "ai" | "student";

export type CourseCategory = { id: string; name: string; order: number };

/** 講義の公開情報。管理情報・招待の秘密値・教員のメールアドレスは含めない。 */
export type CourseViewDTO = { id: string; name: string; categories: CourseCategory[] };

/** ログイン中の利用者がこの講義で使える役割。画面の出し分けに使う（サーバーでも毎回確認する）。 */
export type CourseViewerDTO = { enrolled: boolean; teacher: boolean };

export type MessageDTO = {
  id: string;
  role: MessageRole;
  text: string;
  sequence: number;
  createdAt: string;
  referencedKnowledgeIds?: string[];
};

export type ThreadSummaryDTO = {
  id: string;
  title: string;
  categoryIds: string[];
  status: QuestionStatus;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  summaryStatus: SummaryStatus;
  sharingExcluded?: boolean;
};

/** 生徒本人に返す操作可否。候補の本文は含めない。 */
export type StudentThreadActions = {
  canSendMessage: boolean;
  canEscalate: boolean;
  canResolve: boolean;
  canRetryAi: boolean;
  canRequestRegeneration: boolean;
  canRetrySummary: boolean;
};

export type StudentThreadDetailDTO = ThreadSummaryDTO & {
  escalatedBy: EscalatedBy | null;
  messages: MessageDTO[];
  actions: StudentThreadActions;
  relatedQuestion?: { id: string; title: string };
};

/** 担当教員に返す相談の詳細。本人表示は相談作成時点の Google 表示名（なければ検証済みメール）。 */
export type TeacherThreadDetailDTO = ThreadSummaryDTO & {
  escalatedBy: EscalatedBy | null;
  messages: MessageDTO[];
  student: { displayName: string | null };
  actions: { canReply: boolean; canRequestDraft: boolean };
  relatedQuestion?: { id: string; title: string };
};

export type ThreadDetailDTO = StudentThreadDetailDTO | TeacherThreadDetailDTO;

export type DraftVersionKind = "generated" | "teacher_edit";

export type DraftVersionDTO = {
  id: string;
  kind: DraftVersionKind;
  question: string;
  answer: string;
  categoryId: string;
  basedOnVersionId: string | null;
  /** 生成に使った会話の最後の sequence（教員編集版は null）。 */
  untilSequence: number | null;
  createdAt: string;
};

export type DraftGenerationReason = "resolve" | "teacher_create" | "regenerate" | "retry";

export type DraftGenerationDTO = {
  id: string;
  reason: DraftGenerationReason;
  requestedBy: "student" | "teacher";
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt: string | null;
};

/** 教員用の候補一覧の1件。 */
export type KnowledgeDraftListDTO = {
  questionId: string;
  status: SummaryStatus;
  /** 選択中の版の question（版がなければ null）。一覧のタイトルに使う。 */
  question: string | null;
  categoryId: string;
  versionCount: number;
  questionResolved: boolean;
  updatedAt: string;
};

/** 教員用の候補の詳細。生徒には返さない。 */
export type KnowledgeDraftDTO = KnowledgeDraftListDTO & {
  publication: "none" | "published" | "dismissed";
  selectedVersionId: string | null;
  publishedVersionId: string | null;
  publishedKnowledgeId: string | null;
  activeGeneration: DraftGenerationDTO | null;
  lastGeneration: DraftGenerationDTO | null;
  versions: DraftVersionDTO[];
};

/** 公開Q&A。内部ID・会話・生徒の情報・候補は含めない。 */
export type PublishedKnowledgeDTO = {
  id: string;
  question: string;
  answer: string;
  categoryId: string;
  publishedAt: string;
};

export type StudentNotificationDTO = {
  id: string;
  questionId: string;
  messageId: string;
  title: string;
  createdAt: string;
  readAt: string | null;
};

/** 公開Q&Aの取り下げ結果（教員用）。questionId は確認待ちに戻した元候補の相談ID（元候補がないQ&Aは null）。 */
export type UnpublishKnowledgeResultDTO = {
  knowledgeId: string;
  status: "unpublished";
  questionId: string | null;
};

export type InviteDTO = {
  /** 発行時だけ返す秘密値。DB には保存しない。 */
  code: string;
  /** 講義ごとの固定の参加パス（例：/join/math-i）。 */
  joinPath: string;
  issuedAt: string;
  expiresAt: string;
};

export type InviteStatusDTO = { active: boolean; issuedAt: string | null; expiresAt: string | null };

export type ApiErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "TOO_MANY_REQUESTS"
  | "INTERNAL_ERROR";

export type ApiSuccess<T> = { data: T };
export type ApiFailure = { error: { code: ApiErrorCode; message: string } };

/** D担当が提供する AI 関数の契約（固定実装と Vertex AI 実装で共通）。 */
export interface AiWorkflow {
  classifyQuestion(input: { text: string; categories: CourseCategory[] }): Promise<{ categoryIds: string[]; title?: string }>;
  answerQuestion(input: { messages: MessageDTO[]; knowledge: PublishedKnowledgeDTO[] }): Promise<AiAnswer>;
  summarizeConversation(input: { messages: MessageDTO[] }): Promise<{ question: string; answer: string }>;
}
