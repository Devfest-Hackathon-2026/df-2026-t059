import type { CourseCategory } from "../workflow-types.ts";
import styles from "./teacher.module.css";

export function CategoryFilter({ categories, selected, onChange }: {
  categories: CourseCategory[];
  selected: string[];
  onChange: (selection: string[]) => void;
}) {
  if (!categories.length) return null;
  return (
    <details className={styles.categoryFilter}>
      <summary>カテゴリで絞り込む <span className="count">{selected.length ? `${selected.length}件選択` : "すべて"}</span></summary>
      <fieldset>
        <legend className="visually-hidden">絞り込むカテゴリ</legend>
        {categories.map(({ id, name }) => (
          <label key={id}>
            <input type="checkbox" checked={selected.includes(id)} onChange={(event) => {
              onChange(event.target.checked ? [...selected, id] : selected.filter((category) => category !== id));
            }} />
            {name}
          </label>
        ))}
      </fieldset>
      {selected.length > 0 && <button type="button" className="text-button" onClick={() => onChange([])}>選択を解除</button>}
    </details>
  );
}
