import type { ConversationMessage } from "@/components/conversation";
import type { ThreadSummaryDTO } from "../../domain/course-workflow.ts";

/** 解決済み・先生回答済みの質問か。履歴に並び、続きの質問を始められる。 */
export function isFinished(thread: Pick<ThreadSummaryDTO, "resolvedAt" | "status">) {
  return Boolean(thread.resolvedAt || thread.status === "teacher_answered");
}

export function needsHistoryDetail(thread: Pick<ThreadSummaryDTO, "resolvedAt" | "status" | "updatedAt">, detail?: Pick<ThreadSummaryDTO, "updatedAt">) {
  // 一覧と詳細は別に読み込む。取得の間に更新された場合は、一覧より新しい詳細を使う。
  return isFinished(thread) && (!detail || detail.updatedAt < thread.updatedAt);
}

export type StudentThreadView = {
  id: string;
  title: string;
  messages: ConversationMessage[];
  status: "open" | "pending" | "waiting" | "answered" | "resolved";
  categoryIds: string[];
  sourceId?: string;
  sharingExcluded?: boolean;
};

export type SharedQuestionView = { id: string; title: string; answer: string; categoryId: string };

export type TeacherReplyNotice = { id: string; threadId: string; title: string; read: boolean };

export const threadStatus: Record<StudentThreadView["status"], string> = {
  open: "相談中",
  pending: "AIが回答中",
  waiting: "先生の回答待ち",
  answered: "先生が回答済み",
  resolved: "解決済み",
};
