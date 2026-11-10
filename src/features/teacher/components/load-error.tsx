import { useState } from "react";
import styles from "./teacher.module.css";

export function LoadError({ message, onRetry }: { message: string; onRetry: () => Promise<void> }) {
  const [retrying, setRetrying] = useState(false);

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className={styles.error}>
      <span role="alert">{message}</span>
      <button type="button" className={styles.retryButton} aria-disabled={retrying} onClick={() => void retry()}>
        {retrying && <span className={`spinner ${styles.retrySpinner}`} aria-hidden="true" />}
        {retrying ? "読み込み中…" : "もう一度読み込む"}
      </button>
    </div>
  );
}
