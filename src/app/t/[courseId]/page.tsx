import { notFound } from "next/navigation";
import { loadCourseActorForPage } from "@/features/auth/course-page";
import { SessionBoundary } from "@/features/auth/session-boundary";
import { TeacherCourseShell } from "@/features/teacher/teacher-course-shell";
import { teacherSearchFromPage } from "@/features/teacher/teacher-location";
import { workflowStore } from "@/server/firestore/workflow";

/**
 * 担当教員の講義ページ（B担当）。ログインと教員の確認は C の関数で行い、担当教員でなければ存在しない場合と同じ 404。
 * 画面は教員用の API（/api/courses/[courseId]/teacher 以下）を呼ぶ。
 */
export default async function TeacherCoursePage({ params, searchParams }: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { courseId } = await params;
  const search = teacherSearchFromPage(await searchParams);
  const actor = await loadCourseActorForPage(courseId, `/t/${encodeURIComponent(courseId)}${search}`);
  if (!actor.teacher) notFound();
  const course = await workflowStore.getCourseView(actor, courseId);
  return (
    <SessionBoundary key={course.id}>
      <TeacherCourseShell
        course={course}
        studentHref={actor.enrolled ? `/c/${encodeURIComponent(courseId)}` : undefined}
      />
    </SessionBoundary>
  );
}
