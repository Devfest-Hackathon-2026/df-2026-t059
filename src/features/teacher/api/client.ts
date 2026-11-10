import { fetchWithSession } from "../../auth/session-fetch.ts";
import type {
  CourseCategory,
  DismissDraftResult,
  DraftPublicationFilter,
  InviteDTO,
  InviteStatusDTO,
  KnowledgeDraftDTO,
  KnowledgeDraftListDTO,
  PublishDraftInput,
  PublishedKnowledgeDTO,
  SaveDraftEditInput,
  SelectDraftVersionInput,
  TeacherThreadDetailDTO,
  ThreadSummaryDTO,
  UnpublishKnowledgeResultDTO,
} from "../workflow-types.ts";
import { TeacherApiError, type TeacherErrorCode } from "./errors.ts";

export type TeacherThreadStatus = "escalated" | "teacher_answered" | "ai_answered";

/** regenerate は新規作成・別案、retry は直前の生成が失敗したときの再試行。 */
export type DraftRequestMode = "regenerate" | "retry";

/** 教員画面が使う操作の一覧。実APIと固定データを同じ形で差し替える。 */
export interface TeacherWorkflowClient {
  listThreads(status: TeacherThreadStatus): Promise<ThreadSummaryDTO[]>;
  readThread(questionId: string): Promise<TeacherThreadDetailDTO>;
  reply(questionId: string, text: string): Promise<TeacherThreadDetailDTO>;
  /**
   * AIで共有候補を作る（候補がなければ新規、あれば別案）。要約が終わるまで待ち、生成後の候補を返す。
   * 要約の失敗は例外にならず、返り値の lastGeneration が failed になる。
   */
  requestDraft(questionId: string, mode?: DraftRequestMode): Promise<KnowledgeDraftDTO>;
  /** 省略時は未公開・未見送りの候補（確認待ち・生成中を含む）。 */
  listDrafts(publication?: DraftPublicationFilter): Promise<KnowledgeDraftListDTO[]>;
  readDraft(questionId: string): Promise<KnowledgeDraftDTO>;
  saveDraftEdit(questionId: string, input: SaveDraftEditInput): Promise<KnowledgeDraftDTO>;
  selectDraftVersion(questionId: string, input: SelectDraftVersionInput): Promise<KnowledgeDraftDTO>;
  publishDraft(questionId: string, input: PublishDraftInput): Promise<PublishedKnowledgeDTO>;
  dismissDraft(questionId: string): Promise<DismissDraftResult>;
  /** 見送った候補を確認待ちに戻す。 */
  restoreDraft(questionId: string): Promise<KnowledgeDraftListDTO>;
  /** 公開中のQ&Aを取り下げる。元候補がある場合は確認待ちに戻す。 */
  unpublishKnowledge(knowledgeId: string): Promise<UnpublishKnowledgeResultDTO>;
  /** 共有済みのQ&A（新しい順）。 */
  listPublished(): Promise<PublishedKnowledgeDTO[]>;
  /** カテゴリの追加・変更。返り値は並び順にそろえた講義のカテゴリ全体。 */
  addCategory(name: string): Promise<CourseCategory[]>;
  updateCategory(categoryId: string, input: { name?: string; order?: number }): Promise<CourseCategory[]>;
  /** この講義に参加している生徒の人数。 */
  getStudentCount(): Promise<number>;
  getInviteStatus(): Promise<InviteStatusDTO>;
  /** 発行・再発行。コードはこの返り値でだけ受け取れる。 */
  issueInvite(): Promise<InviteDTO>;
  revokeInvite(): Promise<InviteStatusDTO>;
}

const errorCodes: readonly string[] = [
  "INVALID_INPUT",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "INTERNAL_ERROR",
];
const fallbackMessage = "処理に失敗しました。時間をおいてもう一度お試しください。";

function isErrorCode(value: unknown): value is TeacherErrorCode {
  return typeof value === "string" && errorCodes.includes(value);
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

async function request<T>(url: string, init: { method?: Method; body?: unknown } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetchWithSession(url, {
      method: init.method ?? "GET",
      cache: "no-store",
      ...(init.body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) }),
    });
  } catch {
    throw new TeacherApiError("NETWORK_ERROR", "通信に失敗しました。接続を確認してもう一度お試しください。");
  }

  const payload: unknown = await response.json().catch(() => undefined);
  const envelope = (typeof payload === "object" && payload !== null ? payload : {}) as {
    data?: T;
    error?: { code?: unknown; message?: unknown };
  };
  if (!response.ok || envelope.data === undefined) {
    const { code, message } = envelope.error ?? {};
    throw new TeacherApiError(
      isErrorCode(code) ? code : "INTERNAL_ERROR",
      typeof message === "string" && message ? message : fallbackMessage,
    );
  }
  return envelope.data;
}

/** 共通契約と docs/implementation/b-teacher.md のAPIを呼ぶ。本人確認はサーバーがセッション Cookie で行うため、IDや役割は送らない。 */
export function createHttpTeacherClient(courseId: string): TeacherWorkflowClient {
  const course = `/api/courses/${encodeURIComponent(courseId)}`;
  const teacher = `${course}/teacher`;
  const id = encodeURIComponent;
  const draft = (questionId: string) => `${teacher}/knowledge-drafts/${id(questionId)}`;
  return {
    listThreads: (status) => request(`${teacher}/questions?status=${status}`),
    readThread: (questionId) => request(`${course}/questions/${id(questionId)}`),
    reply: (questionId, text) =>
      request(`${teacher}/questions/${id(questionId)}/reply`, { method: "POST", body: { text } }),
    requestDraft: (questionId, mode = "regenerate") =>
      request(`${teacher}/questions/${id(questionId)}/draft`, { method: "POST", body: { mode } }),
    listDrafts: (publication) =>
      request(`${teacher}/knowledge-drafts${publication === "dismissed" ? "?publication=dismissed" : ""}`),
    readDraft: (questionId) => request(draft(questionId)),
    saveDraftEdit: (questionId, input) => request(`${draft(questionId)}/edit`, { method: "POST", body: input }),
    selectDraftVersion: (questionId, input) => request(`${draft(questionId)}/select`, { method: "POST", body: input }),
    publishDraft: (questionId, input) => request(`${draft(questionId)}/publish`, { method: "POST", body: input }),
    dismissDraft: (questionId) => request(`${draft(questionId)}/dismiss`, { method: "POST" }),
    restoreDraft: (questionId) => request(`${draft(questionId)}/restore`, { method: "POST" }),
    unpublishKnowledge: (knowledgeId) =>
      request(`${teacher}/knowledge/${id(knowledgeId)}/unpublish`, { method: "POST" }),
    listPublished: () => request(`${teacher}/knowledge`),
    addCategory: (name) => request(`${teacher}/categories`, { method: "POST", body: { name } }),
    updateCategory: (categoryId, input) =>
      request(`${teacher}/categories/${id(categoryId)}`, { method: "PATCH", body: input }),
    getStudentCount: () => request<{ count: number }>(`${teacher}/students`).then(({ count }) => count),
    getInviteStatus: () => request(`${teacher}/invite`),
    issueInvite: () => request(`${teacher}/invite`, { method: "POST" }),
    revokeInvite: () => request(`${teacher}/invite`, { method: "DELETE" }),
  };
}
