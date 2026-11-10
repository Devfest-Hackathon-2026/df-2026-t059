"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { MathfieldElement } from "mathlive";
import { LoadingStatus } from "@/components/loading-status";
import "mathlive/fonts.css";
import styles from "./math-input.module.css";

const templates = [
  { label: "分数", value: "\\frac{#0}{#?}" },
  { label: "平方根", value: "\\sqrt{#0}" },
  { label: "累乗", value: "{#0}^{#?}" },
  { label: "括弧", value: "\\left(#0\\right)" },
] as const;

export function MathInput({ value, disabled, onChange, onRemove }: {
  value: string;
  disabled: boolean;
  onChange: (value: string, complete: boolean) => void;
  onRemove: () => void;
}) {
  const labelId = useId();
  const host = useRef<HTMLDivElement>(null);
  const field = useRef<MathfieldElement | null>(null);
  const current = useRef({ value, disabled, onChange });
  current.current = { value, disabled, onChange };
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let active = true;
    let element: MathfieldElement | undefined;
    const update = () => {
      if (!element) return;
      const latex = element.value;
      const complete = element.errors.length === 0 && !/\\placeholder\b|\{\s*\}/u.test(latex);
      current.current.onChange(latex, complete);
    };
    const preventSubmit = (event: KeyboardEvent) => {
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); }
    };
    void import("mathlive").then(({ MathfieldElement }) => {
      if (!active) return;
      // Fonts are bundled by Next.js through fonts.css; no CDN or sound assets are needed.
      MathfieldElement.fontsDirectory = null;
      MathfieldElement.soundsDirectory = null;
      MathfieldElement.locale = "ja";
      element = new MathfieldElement();
      element.value = current.current.value;
      element.readOnly = current.current.disabled;
      element.mathVirtualKeyboardPolicy = "auto";
      element.setAttribute("aria-labelledby", labelId);
      element.setAttribute("aria-label", "数式を入力");
      element.addEventListener("input", update);
      element.addEventListener("keydown", preventSubmit);
      container.appendChild(element);
      field.current = element;
      setReady(true);
      update();
      if (!current.current.disabled) element.focus();
    }).catch(() => { if (active) setFailed(true); });
    return () => {
      active = false;
      if (element) {
        element.removeEventListener("input", update);
        element.removeEventListener("keydown", preventSubmit);
        if (document.activeElement === element) {
          element.blur();
          window.mathVirtualKeyboard?.hide();
        }
        element.remove();
      }
      field.current = null;
    };
  }, [labelId]);

  useEffect(() => {
    const element = field.current;
    if (!element) return;
    if (element.value !== value) element.setValue(value, { silenceNotifications: true });
    element.readOnly = disabled;
    if (disabled && document.activeElement === element) window.mathVirtualKeyboard?.hide();
  }, [value, disabled]);

  return (
    <section className={styles.panel} aria-labelledby={labelId}>
      <div className={styles.heading}>
        <strong id={labelId}>数式</strong>
        <button type="button" className="text-button" disabled={disabled} onClick={onRemove}>数式を削除</button>
      </div>
      <div className={styles.field} ref={host} />
      {!ready && !failed && <LoadingStatus className={styles.hint}>数式入力を準備しています。</LoadingStatus>}
      {failed && <p className={styles.hint} role="alert">数式入力を読み込めませんでした。文章で質問するか、数式欄を開き直してください。</p>}
      {ready && <>
        <fieldset className={styles.templates} disabled={disabled}>
          <legend className="visually-hidden">数式の形を選ぶ</legend>
          {templates.map(({ label, value }) => (
            <button key={label} type="button" className="secondary-button" disabled={disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => field.current?.insert(value, { selectionMode: "placeholder", focus: true })}>{label}</button>
          ))}
        </fieldset>
        <p className={styles.hint}>文章と一緒に送信できます。キーボードのボタンから記号も選べます。</p>
      </>}
    </section>
  );
}
