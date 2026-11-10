"use client";

import { type ReactNode, useEffect, useId, useRef } from "react";
import { Icon } from "./icon";

export function Dialog({ title, onClose, children, className, busy = false }: {
  title: ReactNode; onClose: () => void; children: ReactNode; className?: string; busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog className={className ? `dialog ${className}` : "dialog"} ref={ref} aria-labelledby={titleId} onCancel={(event) => {
      if (busy) event.preventDefault();
      else onClose();
    }}>
      <div className="dialog-heading">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" aria-label="閉じる" disabled={busy} onClick={onClose}><Icon name="close" /></button>
      </div>
      {children}
    </dialog>
  );
}
