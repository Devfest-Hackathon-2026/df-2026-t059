import type { KeyboardEvent } from "react";
import styles from "./teacher.module.css";

export type DraftTab = "preview" | "edit" | "source";

const tabs: { id: DraftTab; label: string }[] = [
  { id: "preview", label: "プレビュー" },
  { id: "edit", label: "編集" },
  { id: "source", label: "元の会話" },
];

export const draftTabId = (panelId: string, tab: DraftTab) => `${panelId}-${tab}`;

/** 狭い画面の「共有するQ&Aを確認」のタブ。左右キーでも切り替えられる。 */
export function DraftTabs({ tab, onChange, panelId }: {
  tab: DraftTab;
  onChange: (tab: DraftTab) => void;
  panelId: string;
}) {
  const moveWithKeys = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = tabs.findIndex(({ id }) => id === tab);
    const next = tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length].id;
    onChange(next);
    document.getElementById(draftTabId(panelId, next))?.focus();
  };

  return (
    <div className={styles.tabs} role="tablist" aria-label="確認する内容">
      {tabs.map(({ id, label }) => (
        <button type="button" key={id} id={draftTabId(panelId, id)} className={styles.tab} role="tab"
          aria-selected={tab === id} aria-controls={panelId} tabIndex={tab === id ? 0 : -1}
          onClick={() => onChange(id)} onKeyDown={moveWithKeys}>
          {label}
        </button>
      ))}
    </div>
  );
}
