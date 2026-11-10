import Link from "next/link";
import { MathTitle } from "@/components/math-title";
import { redirect } from "next/navigation";
import { Icon } from "@/components/icon";
import { JoinCourseDialogButton, LogoutButton } from "@/features/auth/auth-forms";
import styles from "@/features/auth/auth.module.css";
import { SessionBoundary } from "@/features/auth/session-boundary";
import { getPrincipal } from "@/server/auth/actor";
import { listMyCourses } from "@/server/auth/course-actor";

export default async function Home() {
  const principal = await getPrincipal();
  if (!principal) redirect("/login");
  const courses = await listMyCourses(principal);

  const teachingCourses = courses.filter((c) => c.teacher);
  const enrolledCourses = courses.filter((c) => c.enrolled);

  return (
    <SessionBoundary>
      <main className={styles.shell}>
        <header className={styles.shellHeader}>
          <div>
            <h1>講義一覧</h1>
            <p className={styles.muted}>自分が担当する講義と、受講している講義を確認できます。</p>
          </div>
          <LogoutButton />
        </header>

        <nav className={styles.courseActions} aria-label="講義を作成・参加">
          <Link className={`${styles.actionLink} ${styles.primaryLink}`} href="/courses/new">
            <Icon name="plus" />講義を作成
          </Link>
          <JoinCourseDialogButton />
        </nav>

        {courses.length === 0 ? (
          <p className={styles.slot}>講義がまだありません。「講義を作成」するか、「参加コードで参加」から講義に参加できます。</p>
        ) : (
          <div className={styles.stack} style={{ gap: "32px" }}>
            {teachingCourses.length > 0 && (
              <section className={styles.courseSection} aria-labelledby="teaching-courses-heading">
                <div className={styles.sectionHeader}>
                  <h2 id="teaching-courses-heading">担当している講義</h2>
                  <span className={styles.countBadge}>{teachingCourses.length}</span>
                </div>
                <ul className={styles.courseGrid} aria-label="担当している講義一覧">
                  {teachingCourses.map(({ id, name }) => {
                    const encoded = encodeURIComponent(id);
                    return (
                      <li key={`teacher-${id}`}>
                        <Link className={styles.courseCardLink} href={`/t/${encoded}`} aria-label={`${name}（教員画面）`}>
                          <h3 className={styles.courseCardTitle}><MathTitle text={name} /></h3>
                          <div className={styles.courseCardFooter}>
                            <span className={styles.roleTag}>担当</span>
                            <span className={styles.cardArrow} aria-hidden="true">
                              <Icon name="arrow" size={16} />
                            </span>
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {enrolledCourses.length > 0 && (
              <section className={styles.courseSection} aria-labelledby="enrolled-courses-heading">
                <div className={styles.sectionHeader}>
                  <h2 id="enrolled-courses-heading">受講している講義</h2>
                  <span className={styles.countBadge}>{enrolledCourses.length}</span>
                </div>
                <ul className={styles.courseGrid} aria-label="受講している講義一覧">
                  {enrolledCourses.map(({ id, name }) => {
                    const encoded = encodeURIComponent(id);
                    return (
                      <li key={`enrolled-${id}`}>
                        <Link className={styles.courseCardLink} href={`/c/${encoded}`} aria-label={`${name}（生徒画面）`}>
                          <h3 className={styles.courseCardTitle}><MathTitle text={name} /></h3>
                          <div className={styles.courseCardFooter}>
                            <span className={styles.roleTag}>受講中</span>
                            <span className={styles.cardArrow} aria-hidden="true">
                              <Icon name="arrow" size={16} />
                            </span>
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </div>
        )}
      </main>
    </SessionBoundary>
  );
}
