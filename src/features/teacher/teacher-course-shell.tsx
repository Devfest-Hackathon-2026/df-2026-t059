"use client";

import Link from "next/link";
import { LogoutButton } from "../auth/auth-forms";
import authStyles from "../auth/auth.module.css";
import { TeacherDashboard } from "./teacher-dashboard";
import type { CourseViewDTO } from "./workflow-types.ts";

/** `/t/[courseId]` の画面。生徒の講義ページと同じ枠に、リンク・ログアウトを見出し行の操作として渡す。 */
export function TeacherCourseShell({ course, studentHref }: {
  course: CourseViewDTO;
  /** 先生がこの講義の生徒としても参加しているときだけ、生徒画面へのリンクを出す */
  studentHref?: string;
}) {
  return (
    <main className={`${authStyles.shell} course-shell`}>
      <TeacherDashboard key={course.id} course={course} headerActions={
        <div className={authStyles.shellLinks}>
          <Link href="/">講義一覧へ</Link>
          {studentHref && <Link href={studentHref}>生徒画面へ</Link>}
          <LogoutButton />
        </div>
      } />
    </main>
  );
}
