import "server-only";
import type { StudentThreadDetailDTO } from "../../domain/course-workflow.ts";
import { type CourseActor, studentView } from "../../server/auth/access.ts";
import { workflowStore } from "../../server/firestore/workflow.ts";
import {
  answerWithConfiguredAi,
  requestAndGenerateDraft,
  summarizeWithConfiguredAi,
} from "../../server/workflow/ai-steps.ts";

// 生徒用 API の主体は C の共通入口（requireStudentActor）で作る。既存の import 先を保つため再エクスポートする。
export { requireStudentActor } from "../../server/auth/actor.ts";

async function readOwnThread(actor: CourseActor, courseId: string, questionId: string) {
  return await workflowStore.readThread(studentView(actor), courseId, questionId) as StudentThreadDetailDTO;
}

export async function createStudentQuestion(actor: CourseActor, courseId: string, text: unknown, sourceQuestionId?: unknown) {
  const { thread, aiTurn } = await workflowStore.createQuestion(actor, courseId, { text, sourceQuestionId });
  await answerWithConfiguredAi(aiTurn);
  return readOwnThread(actor, courseId, thread.id);
}

export async function addStudentMessage(actor: CourseActor, courseId: string, questionId: string, text: unknown) {
  const { aiTurn } = await workflowStore.addStudentMessage(actor, courseId, questionId, { text });
  if (aiTurn) await answerWithConfiguredAi(aiTurn);
  return readOwnThread(actor, courseId, questionId);
}

export async function retryStudentAnswer(actor: CourseActor, courseId: string, questionId: string) {
  const { aiTurn } = await workflowStore.retryAiTurn(actor, courseId, questionId);
  await answerWithConfiguredAi(aiTurn);
  return readOwnThread(actor, courseId, questionId);
}

export async function resolveStudentQuestion(actor: CourseActor, courseId: string, questionId: string) {
  const { generation } = await workflowStore.resolveQuestion(actor, courseId, questionId);
  if (generation) await summarizeWithConfiguredAi(generation);
  return readOwnThread(actor, courseId, questionId);
}

export async function generateStudentSummary(actor: CourseActor, courseId: string, questionId: string, mode: "retry" | "regenerate") {
  await requestAndGenerateDraft(actor, courseId, questionId, { mode });
  return readOwnThread(actor, courseId, questionId);
}
