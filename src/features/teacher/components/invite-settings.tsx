import { useCallback, useEffect, useState } from "react";
import { LoadingStatus, Spinner } from "@/components/loading-status";
import { courseJoinPath } from "@/features/auth/next-path";
import type { TeacherWorkflowClient } from "../api/client.ts";
import { messageOf } from "../api/errors.ts";
import { formatDateTime } from "../format.ts";
import { useAsyncData } from "../hooks/use-async-data.ts";
import type { InviteDTO } from "../workflow-types.ts";
import { LoadError } from "./load-error";
import { TeacherDialog } from "./teacher-dialog";
import styles from "./teacher.module.css";

type Confirming = "issue" | "revoke";

const confirmTexts: Record<Confirming, { title: string; body: string; action: string }> = {
  issue: {
    title: "参加コードを再発行しますか？",
    body: "現在のコードはすぐに失効します。新しいコードを生徒に共有してください。",
    action: "再発行する",
  },
  revoke: {
    title: "参加コードを無効にしますか？",
    body: "新しく参加する生徒には、別の参加コードを発行してください。",
    action: "無効にする",
  },
};

/**
 * 招待の発行・再発行・無効化。コードはサーバーに保存されないため、発行した直後だけ表示する。
 * もう一度見せたいときは再発行する。
 */
export function InviteSettings({ client, courseId, issuedInvite, onIssued }: {
  client: TeacherWorkflowClient;
  courseId: string;
  /** 発行した参加コード。タブを切り替えても消えないよう、親が持つ */
  issuedInvite: InviteDTO | undefined;
  onIssued: (invite: InviteDTO) => void;
}) {
  const fetchStatus = useCallback(() => client.getInviteStatus(), [client]);
  const { data: status, setData: setStatus, error: loadError, reload } = useAsyncData(fetchStatus);
  // 期限切れ・無効化・ほかの先生の再発行の後は、手元のコードは使えないため表示しない。
  const issued = issuedInvite && status?.expiresAt === issuedInvite.expiresAt ? issuedInvite : undefined;
  const fetchStudentCount = useCallback(() => client.getStudentCount(), [client]);
  // 件数は補助の情報なので、取得に失敗したら表示しないだけにする。設定タブを開くたびに取り直す。
  const { data: studentCount } = useAsyncData(fetchStudentCount);
  const [confirming, setConfirming] = useState<Confirming>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState<string>();
  const [joinUrl, setJoinUrl] = useState<string>();

  useEffect(() => {
    setJoinUrl(`${window.location.origin}${courseJoinPath(courseId)}`);
  }, [courseId]);

  const expiresAt = status?.expiresAt;
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(() => {
      setStatus((current) => current?.expiresAt === expiresAt ? { active: false, issuedAt: null, expiresAt: null } : current);
    }, Math.max(0, Date.parse(expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt, setStatus]);

  const issue = async () => {
    setBusy(true);
    setError(undefined);
    setCopied(undefined);
    try {
      const invite = await client.issueInvite();
      onIssued(invite);
      setStatus({ active: true, issuedAt: invite.issuedAt, expiresAt: invite.expiresAt });
      setConfirming(undefined);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    setError(undefined);
    setCopied(undefined);
    try {
      setStatus(await client.revokeInvite());
      setConfirming(undefined);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(`${label}をコピーしました。`);
    } catch {
      setCopied(`${label}をコピーできませんでした。選択してコピーしてください。`);
    }
  };

  return (
    <section className="surface" aria-labelledby="invite-settings-heading">
      <div className="panel-heading">
        <h2 id="invite-settings-heading">生徒の招待</h2>
        {studentCount !== undefined && <span className="count">参加生徒 {studentCount}人</span>}
      </div>
      <div className={styles.panelBody}>
      <p className={styles.settingsIntro}>
        参加URLまたは共有IDを生徒に伝えてください。初回の参加には、発行から30分有効な参加コードも必要です。
      </p>
      <div className={styles.issued}>
        {joinUrl && (
          <label>参加URL
            <span className={styles.copyRow}>
              <input readOnly value={joinUrl} onFocus={(event) => event.target.select()} />
              <button type="button" className="secondary-button" aria-label="参加URLをコピー" onClick={() => void copy("参加URL", joinUrl)}>コピー</button>
            </span>
          </label>
        )}
        <label>共有ID
          <span className={styles.copyRow}>
            <input readOnly value={courseId} onFocus={(event) => event.target.select()} />
            <button type="button" className="secondary-button" aria-label="共有IDをコピー" onClick={() => void copy("共有ID", courseId)}>コピー</button>
          </span>
        </label>
      </div>
      {status ? (
        <p className={styles.inviteStatus} role="status">
          {expiresAt ? `参加コードは ${formatDateTime(expiresAt)} まで有効です。` : "有効な参加コードはありません。"}
        </p>
      ) : loadError ? (
        <LoadError message={loadError} onRetry={reload} />
      ) : (
        <LoadingStatus className={styles.status}>参加コードの状態を読み込み中です…</LoadingStatus>
      )}
      {issued && (
        <div className={styles.issued}>
          <label>参加コード
            <span className={styles.copyRow}>
              <input className={styles.codeInput} readOnly value={issued.code} onFocus={(event) => event.target.select()} />
              <button type="button" className="secondary-button" aria-label="参加コードをコピー" onClick={() => void copy("参加コード", issued.code)}>コピー</button>
            </span>
          </label>
          <p className={styles.hint}>再読み込みやページの移動をすると、参加コードはもう表示されません。必要なら再発行してください。</p>
        </div>
      )}
      {copied && <p className={styles.hint} role="status">{copied}</p>}
      {error && !confirming && <p className={styles.error} role="alert">{error}</p>}
      {status && (
        <div className={styles.inviteActions}>
          {status.active && (
            <button type="button" className="text-button" disabled={busy} onClick={() => {
              setError(undefined);
              setConfirming("revoke");
            }}>無効にする</button>
          )}
          <button type="button" className="primary-button" disabled={busy} onClick={() => {
            setError(undefined);
            if (status.active) setConfirming("issue");
            else void issue();
          }}>
            {busy && !confirming && <Spinner />}
            {busy && !confirming ? "発行中…" : status.active ? "参加コードを再発行" : "参加コードを発行"}
          </button>
        </div>
      )}
      </div>
      {confirming && (
        <TeacherDialog title={confirmTexts[confirming].title} busy={busy} onClose={() => setConfirming(undefined)}>
          <p className="dialog-intro">{confirmTexts[confirming].body}</p>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="text-button" disabled={busy} onClick={() => setConfirming(undefined)}>キャンセル</button>
            <button type="button" className="primary-button" disabled={busy}
              onClick={() => void (confirming === "issue" ? issue() : revoke())}>
              {busy ? "処理中…" : confirmTexts[confirming].action}
            </button>
          </div>
        </TeacherDialog>
      )}
    </section>
  );
}
