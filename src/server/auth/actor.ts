import "server-only";
import { cookies } from "next/headers.js";
import { notFound, unauthenticated } from "../errors.ts";
import { type CourseActor, canActAsTeacher, type Principal, studentView } from "./access.ts";
import { buildCourseActor } from "./course-actor.ts";
import { SESSION_COOKIE, verifySessionCookie } from "./session.ts";

// HTTP の入口（Route Handler・サーバーコンポーネント）で本人と講義での役割を確定する。
// 役割は毎回サーバーで Firestore から判定する（Cookie やリクエストに役割を持たせない）。

function readCookieHeader(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(rest.join("="));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function sessionValue(request: Request | null): Promise<string | undefined> {
  if (request) return readCookieHeader(request.headers.get("cookie"), SESSION_COOKIE);
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/** ログイン中の本人。未ログインなら null。 */
export async function getPrincipal(request: Request | null = null): Promise<Principal | null> {
  return verifySessionCookie(await sessionValue(request));
}

/** ログイン中の本人。未ログインなら 401。 */
export async function requirePrincipal(request: Request | null = null): Promise<Principal> {
  const principal = await getPrincipal(request);
  if (!principal) throw unauthenticated();
  return principal;
}

export { buildCourseActor };

/** Route Handler 用。request を渡すと、その Cookie ヘッダーを検証する。null ならサーバーコンポーネントの Cookie。 */
export async function requireCourseActor(request: Request | null, courseId: string): Promise<CourseActor> {
  return buildCourseActor(await requirePrincipal(request), courseId);
}

/**
 * 生徒用 Route Handler の入口。兼任者（教員でもある参加者）も、生徒用 API では本人としての権限だけを使う。
 * 参加済みかどうかはここでは確認しない（未参加の扱い＝投稿・一覧は 403、相談の詳細などは 404 を、各ストア関数の契約のまま保つ）。
 */
export async function requireStudentActor(request: Request | null, courseId: string): Promise<CourseActor> {
  return studentView(await requireCourseActor(request, courseId));
}

/**
 * 教員用 Route Handler の入口。その講義の担当教員でなければ、存在しない場合と同じ 404。
 * 兼任者は教員として使える（生徒としての参加は外さない）。ストアの中でも同じ判定を行う。
 */
export async function requireTeacherActor(request: Request | null, courseId: string): Promise<CourseActor> {
  const actor = await requireCourseActor(request, courseId);
  if (!canActAsTeacher(actor, courseId)) throw notFound();
  return actor;
}
