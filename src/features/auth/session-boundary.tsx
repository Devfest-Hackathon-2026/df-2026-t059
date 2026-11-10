"use client";

import { type ReactNode, useEffect, useState } from "react";
import { LoginForms } from "./auth-forms";
import styles from "./auth.module.css";
import { loginPath } from "./next-path";
import { SESSION_EXPIRED_EVENT } from "./session-fetch";

export function SessionBoundary({ children, invite = false }: { children: ReactNode; invite?: boolean }) {
  const [loginHref, setLoginHref] = useState<string>();
  useEffect(() => {
    const expire = () => setLoginHref(loginPath(window.location.pathname + window.location.search));
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, expire);
    window.addEventListener("pageshow", restore);
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, expire);
      window.removeEventListener("pageshow", restore);
    };
  }, []);

  if (!loginHref) return children;
  // 子を外して定期取得を止め、期限切れの画面を表示したままにしない。
  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="session-expired-title">
        <h1 id="session-expired-title">ログインが必要です</h1>
        <p role="alert">セッションが切れました。もう一度ログインして続けてください。</p>
        {invite ? <LoginForms /> : <a className={styles.actionLink} href={loginHref}>再ログイン</a>}
      </section>
    </main>
  );
}
