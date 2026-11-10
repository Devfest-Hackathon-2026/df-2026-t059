import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { LoadingStatus } from "@/components/loading-status";
import { useHoldLocation } from "../hooks/use-teacher-location.ts";
import styles from "./teacher.module.css";

/**
 * Esc キーか。日本語入力の変換中の Esc（変換の取り消し）は含めない。
 * Esc で閉じる処理はブラウザの cancel イベントだけに任せず、キー入力でも受け取る。
 * Firefox 系のブラウザや VS Code の内部ブラウザで、Esc で閉じない報告があったため。
 */
function isEscape(event: KeyboardEvent) {
  return event.key === "Escape" && !event.nativeEvent.isComposing && event.keyCode !== 229;
}

/**
 * 教員画面のダイアログ。×・Esc・外側のクリックで閉じる。
 * - `busy` の間は閉じない。送信中に閉じると、その後の失敗を先生に伝えられず、回答が届かないことに気付けないため。
 * - `dirty` のときは、閉じる前に入力内容を破棄してよいか確認する。
 */
export function TeacherDialog({ title, busy = false, dirty = false, wide = false, fill = false, onClose, children }: {
  title: ReactNode;
  busy?: boolean;
  /** 入力中の内容があるか */
  dirty?: boolean;
  /** 元の会話と並べて編集する画面用の横長表示 */
  wide?: boolean;
  /** 画面の高さいっぱいに広げ、中身の一部だけをスクロールさせる（狭い画面のタブ表示） */
  fill?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const pressedOnBackdrop = useRef(false);
  const titleId = useId();
  const [confirming, setConfirming] = useState(false);
  const [busyHint, setBusyHint] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    if (!busy) setBusyHint(false);
  }, [busy]);

  // ブラウザの「戻る」でも、×やEscと同じく送信中は閉じず、入力中なら確認する。
  useHoldLocation(busy || dirty, () => {
    if (busy) setBusyHint(true);
    else setConfirming(true);
  });

  const requestClose = () => {
    if (busy) {
      setBusyHint(true);
    } else if (dirty && !confirming) {
      setConfirming(true);
    } else if (!dirty) {
      onClose();
    }
  };

  // ダイアログ本体の外（背景）で押して離したときだけ閉じる。本文の文字を選択するドラッグでは閉じない。
  const isBackdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target !== ref.current) return false;
    const rect = ref.current.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right
      || event.clientY < rect.top || event.clientY > rect.bottom;
  };

  return (
    <dialog
      className={["dialog", wide && styles.wideDialog, fill && styles.fillDialog].filter(Boolean).join(" ")}
      ref={ref}
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (!isEscape(event)) return;
        // ブラウザの cancel と二重に処理しないよう、既定の動作は止める
        event.preventDefault();
        requestClose();
      }}
      onCancel={(event) => {
        // 重ねた確認ダイアログのイベントは、そちらで処理する
        if (event.target !== ref.current) return;
        event.preventDefault();
        requestClose();
      }}
      onClose={(event) => {
        if (event.target !== ref.current) return;
        // ブラウザは Esc の連打などで cancel を経ずに閉じることがあるので、画面の状態と揃える。
        if (ref.current?.open) return;
        if (busy || dirty) {
          ref.current?.showModal();
          requestClose();
        } else {
          onClose();
        }
      }}
      onMouseDown={(event) => {
        pressedOnBackdrop.current = isBackdrop(event);
      }}
      onClick={(event) => {
        if (pressedOnBackdrop.current && isBackdrop(event)) requestClose();
        pressedOnBackdrop.current = false;
      }}
    >
      <div className="dialog-heading">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" aria-label="閉じる" disabled={busy} onClick={requestClose}>
          <Icon name="close" />
        </button>
      </div>
      {busy && busyHint && (
        <p className={styles.busyHint} role="status">送信中は閉じられません。完了するまでお待ちください。</p>
      )}
      {busy && !busyHint && <LoadingStatus className={styles.status}>処理中です…</LoadingStatus>}
      {children}
      {confirming && (
        <ConfirmDialog title="入力中の内容を破棄しますか？" body="保存されていない内容は失われます。"
          keepLabel="編集を続ける" confirmLabel="破棄して閉じる" onKeep={() => setConfirming(false)} onConfirm={onClose} />
      )}
    </dialog>
  );
}

/**
 * 取り消せない操作の前に確かめる小さなダイアログ。Esc・外側のクリックは「やめる」側（onKeep）。
 * TeacherDialog の中に重ねても、Esc を下のダイアログに伝えない。
 */
export function ConfirmDialog({ title, body, keepLabel, confirmLabel, onKeep, onConfirm }: {
  title: string;
  body: string;
  keepLabel: string;
  confirmLabel: string;
  onKeep: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    keepRef.current?.focus();
    return () => dialog?.close();
  }, []);

  return (
    <dialog
      className={`dialog ${styles.confirmDialog}`}
      ref={ref}
      role="alertdialog"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (!isEscape(event)) return;
        event.preventDefault();
        // 下のダイアログに Esc を伝えない
        event.stopPropagation();
        onKeep();
      }}
      onCancel={(event) => {
        event.preventDefault();
        onKeep();
      }}
      onClose={() => {
        if (!ref.current?.open) onKeep();
      }}
      onClick={(event) => {
        if (event.target === ref.current) {
          const rect = ref.current.getBoundingClientRect();
          const outside = event.clientX < rect.left || event.clientX > rect.right
            || event.clientY < rect.top || event.clientY > rect.bottom;
          if (outside) onKeep();
        }
      }}
    >
      <h2 id={titleId} className={styles.confirmTitle}>{title}</h2>
      <p className="dialog-intro">{body}</p>
      <div className={styles.confirmActions}>
        <button type="button" className="secondary-button" ref={keepRef} onClick={onKeep}>{keepLabel}</button>
        <button type="button" className={`primary-button ${styles.discard}`} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </dialog>
  );
}
