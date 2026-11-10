import "server-only";
import type { KnowledgeDraftDTO } from "../../domain/course-workflow.ts";
import type { CourseActor } from "../../server/auth/access.ts";
import { workflowStore } from "../../server/firestore/workflow.ts";
import { requestAndGenerateDraft } from "../../server/workflow/ai-steps.ts";

// BのAPIのimport先を保ち、担当教員の確認はCの共通入口へ集約する。
export { requireTeacherActor } from "../../server/auth/actor.ts";

export type DraftRequestMode = "regenerate" | "retry";

/** 教員の明示操作で候補を作り、処理後の候補を返す。相談は解決済みにしない。 */
export async function requestTeacherDraft(
  actor: CourseActor,
  courseId: string,
  questionId: string,
  mode: DraftRequestMode,
): Promise<KnowledgeDraftDTO> {
  await requestAndGenerateDraft(actor, courseId, questionId, { mode });
  return workflowStore.readDraft(actor, courseId, questionId);
}
