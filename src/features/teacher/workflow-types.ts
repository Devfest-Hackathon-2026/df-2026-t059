// 教員画面で使う型。共通の型は C の src/domain/course-workflow.ts をそのまま使う。

export type {
  ApiErrorCode,
  CourseCategory,
  CourseViewDTO,
  DraftGenerationDTO,
  DraftVersionDTO,
  InviteDTO,
  InviteStatusDTO,
  KnowledgeDraftDTO,
  KnowledgeDraftListDTO,
  MessageDTO,
  PublishedKnowledgeDTO,
  TeacherThreadDetailDTO,
  ThreadSummaryDTO,
  UnpublishKnowledgeResultDTO,
} from "../../domain/course-workflow.ts";

/** 候補の中身。共有・編集の保存で送る。 */
export type DraftContent = { question: string; answer: string; categoryId: string };

/** 表示中の内容で共有する。`versionId` は編集の元にした版。 */
export type PublishDraftInput = DraftContent & { versionId: string };

/** 先生の編集版として保存する。`expectedSelectedVersionId` は開いた時点の選択中の版（並行編集の検知）。 */
export type SaveDraftEditInput = DraftContent & { baseVersionId: string; expectedSelectedVersionId: string | null };

export type SelectDraftVersionInput = { versionId: string; expectedSelectedVersionId: string | null };

export type DismissDraftResult = { questionId: string; status: "dismissed" };

/** 教員画面の一覧で扱う公開状態。未公開・未見送り（"none"）と、見送った候補（"dismissed"）。 */
export type DraftPublicationFilter = "none" | "dismissed";
