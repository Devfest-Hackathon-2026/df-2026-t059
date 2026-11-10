import Link from "next/link";
import { redirect } from "next/navigation";
import { LogoutButton } from "@/features/auth/auth-forms";
import styles from "@/features/auth/auth.module.css";
import { loadCourseActorForPage } from "@/features/auth/course-page";
import { SessionBoundary } from "@/features/auth/session-boundary";
import { StudentDashboard } from "@/features/student/student-dashboard";
import { studentSearchFromPage } from "@/features/student/student-location";
import { workflowStore } from "@/server/firestore/workflow";

/** 生徒の講義ページ。未参加なら参加ページへ。A担当の生徒画面はここに CourseViewDTO を渡して接続する。 */
export default async function StudentCoursePage({ params, searchParams }: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { courseId } = await params;
  const path = `/c/${encodeURIComponent(courseId)}${studentSearchFromPage(await searchParams)}`;
  const actor = await loadCourseActorForPage(courseId, path);
  if (!actor.enrolled) {
    redirect(actor.teacher ? `/t/${encodeURIComponent(courseId)}` : `/join/${encodeURIComponent(courseId)}`);
  }
  const course = await workflowStore.getCourseView(actor, courseId);
  return (
    <SessionBoundary key={course.id}>
      <main className={`${styles.shell} course-shell`}>
        <StudentDashboard course={course} headerActions={
          <div className={styles.shellLinks}>
            <Link href="/">講義一覧へ</Link>
            {actor.teacher && <Link href={`/t/${encodeURIComponent(courseId)}`}>教員画面へ</Link>}
            <LogoutButton />
          </div>
        } />
      </main>
    </SessionBoundary>
  );
}
