import "server-only";
import { notFound, redirect } from "next/navigation";
import type { CourseActor } from "@/server/auth/access";
import { buildCourseActor, getPrincipal } from "@/server/auth/actor";
import { isAppError } from "@/server/errors";
import { loginPath } from "./next-path.ts";

/**
 * 講義ページ（サーバーコンポーネント）の入口。未ログインならログインへ、講義がなければ 404。
 * 役割の確認（参加済みか・教員か）は呼び出し側で行い、API・ストアでも同じ判定を毎回行う。
 */
export async function loadCourseActorForPage(courseId: string, returnPath: string): Promise<CourseActor> {
  const principal = await getPrincipal();
  if (!principal) redirect(loginPath(returnPath));
  try {
    return await buildCourseActor(principal, courseId);
  } catch (error) {
    if (isAppError(error) && error.code === "NOT_FOUND") notFound();
    throw error;
  }
}
