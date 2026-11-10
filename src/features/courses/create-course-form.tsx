"use client";

import { type FormEvent, useState } from "react";
import { Spinner } from "@/components/loading-status";
import type { ApiFailure, ApiSuccess } from "@/domain/course-workflow";
import { COURSE_NAME_MAX_LENGTH } from "@/domain/limits";
import styles from "@/features/auth/auth.module.css";
import { fetchWithSession } from "@/features/auth/session-fetch";

type CreateCourseResponse = ApiSuccess<{ id: string }> | ApiFailure;

export function CreateCourseForm({ requestId }: { requestId: string }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(undefined);

    const response = await fetchWithSession("/api/courses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim(), requestId }),
    }).catch(() => null);
    const body = await response?.json().catch(() => null) as CreateCourseResponse | null | undefined;
    if (response?.ok && body && "data" in body && typeof body.data.id === "string") {
      window.location.replace(`/t/${encodeURIComponent(body.data.id)}`);
      return;
    }
    setError(body && "error" in body ? body.error.message : "講義を作成できませんでした。もう一度お試しください。");
    setBusy(false);
  };

  return (
    <form className={styles.stack} onSubmit={submit}>
      <label className={styles.label}>
        講義名
        <input className={styles.plainInput} value={name} onChange={(event) => setName(event.target.value)}
          maxLength={COURSE_NAME_MAX_LENGTH} disabled={busy} required />
      </label>
      <button type="submit" className={styles.primary} disabled={busy || !name.trim()}>
        {busy && <Spinner />}
        {busy ? "作成中…" : "講義を作成する"}
      </button>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </form>
  );
}
