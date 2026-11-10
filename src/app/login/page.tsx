import { redirect } from "next/navigation";
import { LoginForms } from "@/features/auth/auth-forms";
import styles from "@/features/auth/auth.module.css";
import { courseReturnPath } from "@/features/auth/next-path";
import { getPrincipal } from "@/server/auth/actor";

export const metadata = { title: "ログイン | 授業の質問サポート" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const destination = courseReturnPath(next);
  if (await getPrincipal()) redirect(destination);
  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <h1>ログイン</h1>
        <p className={styles.muted}>
          Google アカウント、または登録済みのメールアドレスとパスワードでログインできます。
        </p>
        <LoginForms next={destination} />
      </section>
    </main>
  );
}
