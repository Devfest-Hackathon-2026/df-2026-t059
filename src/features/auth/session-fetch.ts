export const SESSION_EXPIRED_EVENT = "course-session-expired";

/** 講義と参加のAPIがセッション切れを返したとき、表示中のページに知らせる。 */
export async function fetchWithSession(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (response.status === 401 && typeof window !== "undefined") {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  }
  return response;
}
