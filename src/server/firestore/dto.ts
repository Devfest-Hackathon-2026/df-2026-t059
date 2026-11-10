import "server-only";
import type { Timestamp } from "firebase-admin/firestore";
import type {
  DraftGenerationDTO,
  DraftVersionDTO,
  KnowledgeDraftDTO,
  KnowledgeDraftListDTO,
  MessageDTO,
  PublishedKnowledgeDTO,
  StudentThreadDetailDTO,
  TeacherThreadDetailDTO,
  ThreadSummaryDTO,
} from "../../domain/course-workflow.ts";
import { questionHeading } from "../../domain/question-title.ts";
import {
  type DraftMirror,
  effectiveThreadState,
  studentActions,
  summaryStatusOf,
  teacherActions,
  type ThreadState,
} from "../workflow/rules.ts";
import type {
  Draft,
  DraftGenerationRef,
  DraftMirrorRecord,
  DraftVersion,
  Knowledge,
  Message,
  Question,
} from "./models.ts";

// Firestore のレコードを、返してよい項目だけの DTO に変換する。
// 本人表示（studentDisplayName）は toTeacherThreadDetail だけが返す。

export const iso = (value: Timestamp) => value.toDate().toISOString();
const isoOrNull = (value: Timestamp | null) => (value ? iso(value) : null);

export function mirrorFromRecord(record: DraftMirrorRecord | null): DraftMirror | null {
  if (!record) return null;
  return {
    generationRunning: record.generationRunning,
    generationExpiresAtMs: record.generationExpiresAt ? record.generationExpiresAt.toMillis() : null,
    lastGenerationFailed: record.lastGenerationFailed,
    publication: record.publication,
    versionCount: record.versionCount,
  };
}

/** 候補ドキュメントから、相談ドキュメントに複製する状態を作る。 */
export function mirrorRecordFromDraft(draft: Draft): DraftMirrorRecord {
  return {
    generationRunning: !!draft.activeGeneration,
    generationExpiresAt: draft.activeGeneration?.expiresAt ?? null,
    lastGenerationFailed: draft.lastGeneration?.status === "failed",
    publication: draft.publication,
    versionCount: draft.versionCount,
  };
}

/** 判定に使う相談の状態。期限切れの AI 回答は失敗（error）として扱う。 */
export function threadState(question: Question, nowMs: number): ThreadState {
  return effectiveThreadState(rawThreadState(question), nowMs);
}

function rawThreadState(question: Question): ThreadState {
  return {
    status: question.status,
    resolved: !!question.resolvedAt,
    aiAttempt: question.aiAttempt
      ? { id: question.aiAttempt.id, expiresAtMs: question.aiAttempt.expiresAt.toMillis() }
      : null,
    draft: mirrorFromRecord(question.draft),
  };
}

export function toMessageDTO(id: string, message: Message): MessageDTO {
  return {
    id,
    role: message.role,
    text: message.text,
    sequence: message.sequence,
    createdAt: iso(message.createdAt),
    ...(message.referencedKnowledgeIds.length ? { referencedKnowledgeIds: message.referencedKnowledgeIds } : {}),
  };
}

export function toThreadSummary(id: string, question: Question, nowMs: number): ThreadSummaryDTO {
  return {
    id,
    title: questionHeading(question.title),
    categoryIds: question.categoryIds,
    status: threadState(question, nowMs).status,
    resolvedAt: isoOrNull(question.resolvedAt),
    createdAt: iso(question.createdAt),
    updatedAt: iso(question.updatedAt),
    summaryStatus: question.sharingExcluded && question.draft?.publication !== "published"
      ? "dismissed" : summaryStatusOf(mirrorFromRecord(question.draft), nowMs),
    ...(question.sharingExcluded ? { sharingExcluded: true } : {}),
  };
}

export function toStudentThreadDetail(
  id: string,
  question: Question,
  messages: MessageDTO[],
  nowMs: number,
): StudentThreadDetailDTO {
  return {
    ...toThreadSummary(id, question, nowMs),
    escalatedBy: question.escalatedBy,
    messages,
    actions: studentActions(question.sharingExcluded ? { ...threadState(question, nowMs), draft: null } : threadState(question, nowMs), nowMs),
    ...(question.relatedQuestion ? { relatedQuestion: { id: question.relatedQuestion.id, title: questionHeading(question.relatedQuestion.title) } } : {}),
  };
}

export function toTeacherThreadDetail(
  id: string,
  question: Question,
  messages: MessageDTO[],
  nowMs: number,
): TeacherThreadDetailDTO {
  return {
    ...toThreadSummary(id, question, nowMs),
    escalatedBy: question.escalatedBy,
    messages,
    student: { displayName: question.studentDisplayName },
    // 状態表示・ストアの判定と同じ関数から作る（期限切れの AI 回答は error として扱う）。
    actions: { ...teacherActions(threadState(question, nowMs), nowMs), ...(question.sharingExcluded ? { canRequestDraft: false } : {}) },
    ...(question.relatedQuestion ? { relatedQuestion: { id: question.relatedQuestion.id, title: questionHeading(question.relatedQuestion.title) } } : {}),
  };
}

export function toPublishedKnowledge(id: string, knowledge: Knowledge): PublishedKnowledgeDTO {
  return {
    id,
    question: knowledge.question,
    answer: knowledge.answer,
    categoryId: knowledge.categoryId,
    publishedAt: iso(knowledge.publishedAt),
  };
}

function toGenerationDTO(ref: DraftGenerationRef | null): DraftGenerationDTO | null {
  if (!ref) return null;
  return {
    id: ref.id,
    reason: ref.reason,
    requestedBy: ref.requestedBy,
    status: ref.status,
    startedAt: iso(ref.startedAt),
    finishedAt: isoOrNull(ref.finishedAt),
  };
}

export function draftStatus(draft: Draft, nowMs: number) {
  return summaryStatusOf(mirrorFromRecord(mirrorRecordFromDraft(draft)), nowMs);
}

export function toDraftListItem(questionId: string, draft: Draft, nowMs: number): KnowledgeDraftListDTO {
  return {
    questionId,
    status: draftStatus(draft, nowMs),
    question: draft.selectedQuestion,
    categoryId: draft.categoryId,
    versionCount: draft.versionCount,
    questionResolved: draft.questionResolved,
    updatedAt: iso(draft.updatedAt),
  };
}

export function toDraftVersionDTO(id: string, version: DraftVersion): DraftVersionDTO {
  return {
    id,
    kind: version.kind,
    question: version.question,
    answer: version.answer,
    categoryId: version.categoryId,
    basedOnVersionId: version.basedOnVersionId,
    untilSequence: version.untilSequence,
    createdAt: iso(version.createdAt),
  };
}

export function toDraftDTO(
  questionId: string,
  draft: Draft,
  versions: DraftVersionDTO[],
  nowMs: number,
): KnowledgeDraftDTO {
  // 期限切れの生成は実行中ではなく、直前の失敗として見せる（生徒側の状態表示・再試行の判定と同じ扱い）。
  const current = draft.activeGeneration;
  const expired = !!current && current.expiresAt.toMillis() <= nowMs;
  const active = current && !expired ? current : null;
  const last = current && expired ? { ...current, status: "failed" as const, finishedAt: current.expiresAt } : draft.lastGeneration;
  return {
    ...toDraftListItem(questionId, draft, nowMs),
    publication: draft.publication,
    selectedVersionId: draft.selectedVersionId,
    publishedVersionId: draft.publishedVersionId,
    publishedKnowledgeId: draft.publishedKnowledgeId,
    activeGeneration: toGenerationDTO(active),
    lastGeneration: toGenerationDTO(last),
    versions,
  };
}
