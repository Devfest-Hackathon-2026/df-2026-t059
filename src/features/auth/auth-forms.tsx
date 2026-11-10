"use client";

import { type FormEvent, useRef, useState } from "react";
import { Dialog } from "@/components/dialog";
import { Icon } from "@/components/icon";
import { Spinner } from "@/components/loading-status";
import styles from "./auth.module.css";
import { signInWithGoogle, signInWithPassword, signOutEverywhereOnThisDevice } from "./firebase-client";
import { courseReturnPath, invitePath, isCourseId } from "./next-path";
import { fetchWithSession } from "./session-fetch";

type LoginMethod = { kind: "google" } | { kind: "password"; email: string; password: string };

function loginError(cause: unknown): string | null {
  const code = typeof cause === "object" && cause && "code" in cause ? cause.code : undefined;
  switch (code) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return null;
    case "auth/popup-blocked":
      return "ポップアップがブロックされました。このサイトのポップアップを許可してください。";
    case "auth/invalid-credential":
    case "auth/invalid-login-credentials":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "メールアドレスまたはパスワードを確認してください。";
    case "auth/network-request-failed":
      return "通信できませんでした。接続を確認してもう一度お試しください。";
    case "auth/too-many-requests":
      return "試行回数が上限に達しました。時間をおいてもう一度お試しください。";
    default:
      return "ログインできませんでした。もう一度お試しください。";
  }
}

export function LoginForms({ next }: { next?: string }) {
  const active = useRef<{ popup?: AbortController } | null>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<"google-popup" | "google-session" | "password" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const googlePending = pending === "google-popup" || pending === "google-session";

  const login = async (method: LoginMethod) => {
    if (active.current) return;
    const attempt: { popup?: AbortController } = {};
    active.current = attempt;
    setError(null);
    try {
      if (method.kind === "google") {
        const popup = new AbortController();
        attempt.popup = popup;
        setPending("google-popup");
        await signInWithGoogle(popup.signal, () => {
          attempt.popup = undefined;
          setPending("google-session");
        });
      } else {
        setPending("password");
        await signInWithPassword(method.email, method.password);
      }
      if (active.current !== attempt) return;
      if (next === undefined) window.location.reload();
      else window.location.replace(courseReturnPath(next));
    } catch (cause) {
      if (active.current === attempt) setError(loginError(cause));
    } finally {
      if (active.current === attempt) {
        active.current = null;
        setPending(null);
      }
    }
  };

  const cancelPopup = () => {
    const popup = active.current?.popup;
    if (!popup) return;
    active.current = null;
    popup.abort();
    setPending(null);
  };

  const submitPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!emailInput.current || !passwordInput.current) return;
    void login({ kind: "password", email: emailInput.current.value.trim(), password: passwordInput.current.value });
  };

  return (
    <div className={styles.stack}>
      <button type="button" className={styles.primary} onClick={() => void login({ kind: "google" })} disabled={pending !== null}>
        {googlePending && <Spinner />}
        {googlePending ? "ログイン中…" : "Google でログイン"}
      </button>
      {pending === "google-popup" && (
        <button type="button" className={styles.secondary} onClick={cancelPopup}>Google ログインをキャンセル</button>
      )}
      <form className={`${styles.stack} ${styles.passwordForm}`} method="post" onSubmit={submitPassword}>
        <label className={styles.label}>
          メールアドレス
          <input ref={emailInput} id="login-email" className={styles.plainInput} type="email" autoComplete="username" required />
        </label>
        <label className={styles.label}>
          パスワード
          <input ref={passwordInput} id="login-password" className={styles.plainInput} type="password" autoComplete="current-password" required />
        </label>
        <button type="submit" className={styles.primary} disabled={pending !== null}>
          {pending === "password" && <Spinner />}
          {pending === "password" ? "ログイン中…" : "メールでログイン"}
        </button>
      </form>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}

export function InviteLinkForm() {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const path = invitePath(url, window.location.origin);
    if (!path) { setError("先生から受け取ったこのサイトの参加URLを入力してください。"); return; }
    setError(null);
    setOpening(true);
    window.location.assign(path);
  };
  return (
    <form className={styles.stack} onSubmit={submit}>
      <label className={styles.label}>
        参加URL
        <input className={styles.plainInput} type="url" value={url} onChange={(event) => setUrl(event.target.value)} required />
      </label>
      <button type="submit" className={styles.primary} disabled={opening}>{opening && <Spinner />}{opening ? "開いています…" : "参加ページを開く"}</button>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </form>
  );
}

export function JoinForm({ courseId }: { courseId?: string }) {
  const [enteredCourse, setEnteredCourse] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const targetCourse = courseId ?? enteredCourse.trim();
    if (!isCourseId(targetCourse)) {
      setError("共有IDを確認してください。");
      return;
    }
    setBusy(true);
    setError(null);
    const response = await fetchWithSession(`/api/courses/${encodeURIComponent(targetCourse)}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    }).catch(() => null);
    if (response?.ok) {
      // 秘密値を含まない講義ページへ移る。
      window.location.replace(`/c/${encodeURIComponent(targetCourse)}`);
      return;
    }
    const body = await response?.json().catch(() => null);
    setError(body?.error?.message ?? "参加できませんでした。通信状況を確認してください。");
    setBusy(false);
  };
  return (
    <form className={styles.stack} onSubmit={submit}>
      {courseId === undefined && (
        <label className={styles.label}>
          共有ID
          <input className={styles.plainInput} value={enteredCourse} onChange={(event) => setEnteredCourse(event.target.value)} required />
        </label>
      )}
      <label className={styles.label}>
        参加コード
        <input
          className={styles.input}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="XXXX-XXXX"
          autoComplete="off"
          spellCheck={false}
          required
        />
      </label>
      <button type="submit" className={styles.primary} disabled={busy || !code.trim()}>
        {busy && <Spinner />}
        {busy ? "確認中…" : "講義に参加する"}
      </button>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </form>
  );
}

export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <div>
      <button
        type="button"
        className={styles.logoutLink}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(undefined);
          try {
            await signOutEverywhereOnThisDevice();
            window.location.replace("/login");
          } catch {
            setError("ログアウトできませんでした。もう一度お試しください。");
            setBusy(false);
          }
        }}
      >
        {busy && <Spinner />}
        {busy ? "ログアウト中…" : "ログアウト"}
      </button>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}

export function JoinCourseDialogButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={styles.actionButton}
        onClick={() => setOpen(true)}
      >
        <Icon name="plus" />参加コードで参加
      </button>
      {open && (
        <Dialog title="招待から講義に参加" onClose={() => setOpen(false)}>
          <div className={styles.dialogContent}>
            <p className={styles.muted}>先生から受け取った参加URLまたは参加コードを入力してください。</p>
            <InviteLinkForm />
            <details className={styles.joinDetails}>
              <summary>共有IDと参加コードで参加</summary>
              <JoinForm />
            </details>
          </div>
        </Dialog>
      )}
    </>
  );
}
