import type { ApiErrorCode, PublishedKnowledgeDTO, StudentNotificationDTO, StudentThreadDetailDTO, ThreadSummaryDTO } from "../../domain/course-workflow.ts";
import { fetchWithSession } from "../auth/session-fetch.ts";

export class StudentApiError extends Error {
  constructor(readonly code: ApiErrorCode | "NETWORK_ERROR", message: string) {
    super(message);
    this.name = "StudentApiError";
  }
}

async function request<T>(url: string, body?: { text: string; sourceQuestionId?: string } | null): Promise<T> {
  let response: Response;
  try {
    response = await fetchWithSession(url, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new StudentApiError("NETWORK_ERROR", "通信に失敗しました。接続を確認してもう一度お試しください。");
  }
  const payload = await response.json().catch(() => null) as {
    data?: T; error?: { code: ApiErrorCode; message: string };
  } | null;
  if (!response.ok || payload?.data === undefined) {
    throw new StudentApiError(payload?.error?.code ?? "INTERNAL_ERROR", payload?.error?.message ?? "データを取得できませんでした。");
  }
  return payload.data;
}

export function createStudentClient(courseId: string) {
  const course = `/api/courses/${encodeURIComponent(courseId)}`;
  const question = (id: string) => `${course}/questions/${encodeURIComponent(id)}`;
  return {
    listThreads: () => request<ThreadSummaryDTO[]>(`${course}/questions`),
    readThread: (id: string) => request<StudentThreadDetailDTO>(`${question(id)}?view=student`),
    listKnowledge: () => request<PublishedKnowledgeDTO[]>(`${course}/knowledge`),
    readKnowledge: (id: string) => request<PublishedKnowledgeDTO>(`${course}/knowledge/${encodeURIComponent(id)}`),
    listNotifications: () => request<StudentNotificationDTO[]>(`${course}/notifications`),
    readNotification: (id: string) => request<StudentNotificationDTO>(`${course}/notifications/${encodeURIComponent(id)}/read`, null),
    createQuestion: (text: string, sourceQuestionId?: string) => request<StudentThreadDetailDTO>(`${course}/questions`, { text, sourceQuestionId }),
    sendMessage: (id: string, text: string) => request<StudentThreadDetailDTO>(`${question(id)}/messages`, { text }),
    escalate: (id: string) => request<StudentThreadDetailDTO>(`${question(id)}/escalate`, null),
    resolve: (id: string) => request<StudentThreadDetailDTO>(`${question(id)}/resolve`, null),
    retryAi: (id: string) => request<StudentThreadDetailDTO>(`${question(id)}/ai/retry`, null),
    retrySummary: (id: string) => request<StudentThreadDetailDTO>(`${question(id)}/summary/retry`, null),
    regenerateSummary: (id: string) => request<StudentThreadDetailDTO>(`${question(id)}/summary/regenerate`, null),
  };
}
