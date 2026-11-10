import { randomUUID } from "node:crypto";
import Link from "next/link";
import { redirect } from "next/navigation";
import { LogoutButton } from "@/features/auth/auth-forms";
import styles from "@/features/auth/auth.module.css";
import { loginPath } from "@/features/auth/next-path";
import { SessionBoundary } from "@/features/auth/session-boundary";
import { CreateCourseForm } from "@/features/courses/create-course-form";
import { canCreateCourse } from "@/server/auth/access";
import { getPrincipal } from "@/server/auth/actor";

export const metadata = { title: "講義を作成 | 授業の質問サポート" };

export default async function NewCoursePage() {
  const principal = await getPrincipal();
  if (!principal) redirect(loginPath("/courses/new"));

  return (
    <SessionBoundary>
      <main className={styles.page}>
        <section className={styles.card} aria-labelledby="create-course-title">
          <div className={styles.shellLinks}><Link href="/">講義一覧に戻る</Link></div>
          <h1 id="create-course-title">講義を作成</h1>
          {canCreateCourse(principal) ? (
            <>
              <p className={styles.muted}>作成した講義の担当教員になります。作成後に生徒を招待できます。</p>
              <CreateCourseForm requestId={randomUUID()} />
            </>
          ) : (
            <>
              <p className={styles.muted}>講義を作成するには、確認済みのメールアドレスがあるGoogleアカウントでログインしてください。</p>
              <LogoutButton />
            </>
          )}
        </section>
      </main>
    </SessionBoundary>
  );
}
