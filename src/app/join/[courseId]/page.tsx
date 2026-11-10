import Link from "next/link";
import { redirect } from "next/navigation";
import { JoinForm, LoginForms, LogoutButton } from "@/features/auth/auth-forms";
import styles from "@/features/auth/auth.module.css";
import { courseJoinPath } from "@/features/auth/next-path";
import { SessionBoundary } from "@/features/auth/session-boundary";
import { getPrincipal } from "@/server/auth/actor";
import { buildCourseActor } from "@/server/auth/course-actor";
import { isAppError } from "@/server/errors";

export const metadata = { title: "講義に参加 | 授業の質問サポート" };

/** 固定の参加URLから、教員が発行したコードを入力して講義に参加する。 */
export default async function JoinPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const { courseId } = await params;
  const { code } = await searchParams;
  if (code !== undefined) redirect(courseJoinPath(courseId));
  const principal = await getPrincipal();
  if (principal) {
    // 講義の有無は招待を確認するまで表示しない。
    const actor = await buildCourseActor(principal, courseId).catch((error: unknown) => {
      if (isAppError(error) && error.code === "NOT_FOUND") return null;
      throw error;
    });
    if (actor?.enrolled) redirect(`/c/${encodeURIComponent(courseId)}`);
  }
  return (
    <SessionBoundary invite>
      <main className={styles.page}>
        <section className={styles.card}>
          <h1>講義に参加</h1>
          {principal ? (
            <>
              <p className={styles.muted}>先生から受け取った参加コードを入力してください。コードは発行から30分間有効です。</p>
              <JoinForm courseId={courseId} />
              <div className={styles.shellLinks}><Link href="/">講義一覧へ</Link><LogoutButton /></div>
            </>
          ) : (
            <>
              <p className={styles.muted}>ログインして、先生から受け取った参加コードを入力してください。</p>
              <LoginForms />
            </>
          )}
        </section>
      </main>
    </SessionBoundary>
  );
}
