import { type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { LoadingStatus } from "@/components/loading-status";
import { CATEGORY_NAME_MAX_LENGTH } from "../../../domain/limits.ts";
import type { TeacherWorkflowClient } from "../api/client.ts";
import { messageOf } from "../api/errors.ts";
import type { CourseCategory } from "../workflow-types.ts";
import styles from "./teacher.module.css";

/**
 * `from` の項目を `to` の位置へ動かしたときの新しい order。隣との間の値にして、1回の更新で済ませる。
 * 先頭・末尾へ動かすときは、隣の値から 1 ずらす。
 */
function movedOrder(sorted: CourseCategory[], from: number, to: number) {
  const others = sorted.filter((_, index) => index !== from);
  const before = others[to - 1];
  const after = others[to];
  if (before && after) return (before.order + after.order) / 2;
  return before ? before.order + 1 : after.order - 1;
}

type Drag = { id: string; from: number; over: number; dy: number };

/** ドラッグ中に画面の端へ近づいたらスクロールする範囲（px） */
const EDGE_SCROLL_ZONE = 48;
const EDGE_SCROLL_STEP = 12;

function DragDots() {
  return (
    <svg width="14" height="18" viewBox="0 0 14 18" fill="currentColor" aria-hidden="true">
      {[3, 9, 15].flatMap((cy) => [3, 11].map((cx) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.6" />))}
    </svg>
  );
}

/** 講義のカテゴリの追加・名前の変更・並び替え（ドラッグ、またはつまみの上で上下キー）。削除は未合意のため出さない。 */
export function CategorySettings({ client, categories, onChange }: {
  client: TeacherWorkflowClient;
  categories: CourseCategory[];
  onChange: (categories: CourseCategory[]) => void;
}) {
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<string>();
  const [drag, setDrag] = useState<Drag>();
  // 保存が終わるまで、動かした先の並びで表示する（元の位置に一瞬戻さない）。失敗したら元に戻る。
  const [pendingMove, setPendingMove] = useState<{ id: string; order: number }>();
  const listRef = useRef<HTMLUListElement>(null);
  // ドラッグ開始時の各行の位置（ページ座標）。動かしている間の表示のずれに影響されないよう固定する。
  const geometry = useRef<{ startY: number; centers: number[]; height: number }>(undefined);
  const sorted = categories
    .map((category) => (category.id === pendingMove?.id ? { ...category, order: pendingMove.order } : category))
    .sort((a, b) => a.order - b.order);

  const run = async (action: () => Promise<CourseCategory[]>, done: string) => {
    if (busy) return false;
    setBusy(true);
    setError(undefined);
    setInfo(undefined);
    try {
      onChange(await action());
      setInfo(done);
      return true;
    } catch (cause) {
      setError(messageOf(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    if (await run(() => client.addCategory(name), `「${name}」を追加しました。`)) setNewName("");
  };

  const rename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = editing?.name.trim();
    if (!editing || !name) return;
    if (await run(() => client.updateCategory(editing.id, { name }), `名前を「${name}」に変更しました。`)) setEditing(undefined);
  };

  const moveTo = (from: number, to: number) => {
    if (busy) return;
    const category = sorted[from];
    const order = movedOrder(sorted, from, to);
    setPendingMove({ id: category.id, order });
    void run(() => client.updateCategory(category.id, { order }), `「${category.name}」の並び順を変更しました。`)
      .finally(() => setPendingMove(undefined));
  };

  const startDrag = (event: PointerEvent<HTMLButtonElement>, category: CourseCategory, index: number) => {
    if (event.button !== 0 || busy) return;
    const rects = [...(listRef.current?.children ?? [])].map((row) => row.getBoundingClientRect());
    geometry.current = {
      startY: event.pageY,
      centers: rects.map((rect) => rect.top + window.scrollY + rect.height / 2),
      height: rects[index].height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ id: category.id, from: index, over: index, dy: 0 });
  };

  const moveDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const start = geometry.current;
    if (!drag || !start) return;
    if (event.clientY < EDGE_SCROLL_ZONE) window.scrollBy(0, -EDGE_SCROLL_STEP);
    else if (event.clientY > window.innerHeight - EDGE_SCROLL_ZONE) window.scrollBy(0, EDGE_SCROLL_STEP);
    const dy = event.pageY - start.startY;
    const center = start.centers[drag.from] + dy;
    const over = start.centers.filter((value, index) => index !== drag.from && value < center).length;
    setDrag({ ...drag, over, dy });
  };

  const finishDrag = (commit: boolean) => {
    if (!drag) return;
    const { from, over } = drag;
    setDrag(undefined);
    geometry.current = undefined;
    if (commit && from !== over) moveTo(from, over);
  };

  const moveWithKeys = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const to = event.key === "ArrowUp" ? index - 1 : event.key === "ArrowDown" ? index + 1 : -1;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    if (to >= 0 && to < sorted.length) moveTo(index, to);
  };

  /** ドラッグ中の見た目：動かしている行は指に追従し、間の行は1行分よける。 */
  const rowStyle = (index: number): CSSProperties | undefined => {
    if (!drag || !geometry.current) return undefined;
    if (index === drag.from) return { transform: `translateY(${drag.dy}px)` };
    const { height } = geometry.current;
    if (drag.from < drag.over && index > drag.from && index <= drag.over) return { transform: `translateY(${-height}px)` };
    if (drag.over < drag.from && index >= drag.over && index < drag.from) return { transform: `translateY(${height}px)` };
    return undefined;
  };

  return (
    <section className="surface" aria-labelledby="category-settings-heading">
      <div className="panel-heading">
        <h2 id="category-settings-heading">カテゴリ</h2><span className="count">{sorted.length}件</span>
      </div>
      <div className={styles.panelBody}>
      <p className={styles.settingsIntro}>
        質問の分類と、共有するQ&amp;Aのカテゴリに使います。左のつまみをドラッグすると並び替えられます。変更はすぐ反映されます。
      </p>
      <ul className={styles.categoryList} ref={listRef}>
        {sorted.map((category, index) => {
          const dragging = drag?.id === category.id;
          const rowClass = [styles.categoryRow, dragging && styles.categoryRowDragging, drag && !dragging && styles.categoryRowShift]
            .filter(Boolean).join(" ");
          return (
            <li key={category.id} className={rowClass} style={rowStyle(index)}>
              {editing?.id === category.id ? (
                <form className={styles.inlineForm} onSubmit={rename}>
                  <input aria-label={`「${category.name}」の新しい名前`} value={editing.name} maxLength={CATEGORY_NAME_MAX_LENGTH}
                    required disabled={busy} onChange={(event) => setEditing({ ...editing, name: event.target.value })} />
                  <button type="submit" className="secondary-button" disabled={busy || !editing.name.trim()}>保存</button>
                  <button type="button" className="text-button" disabled={busy} onClick={() => setEditing(undefined)}>キャンセル</button>
                </form>
              ) : (
                <>
                  {/* disabled にすると保存中にキーボードのフォーカスが外れ、続けて動かせないため aria-disabled にする */}
                  <button type="button" className={styles.dragHandle} aria-disabled={busy}
                    aria-label={`「${category.name}」を並び替える（${index + 1}番目。上下キーで移動）`}
                    onPointerDown={(event) => startDrag(event, category, index)}
                    onPointerMove={moveDrag}
                    onPointerUp={() => finishDrag(true)}
                    onPointerCancel={() => finishDrag(false)}
                    onKeyDown={(event) => moveWithKeys(event, index)}>
                    <DragDots />
                  </button>
                  <span className={styles.categoryName}>{category.name}</span>
                  <span className={styles.categoryActions}>
                    <button type="button" className="text-button" disabled={busy}
                      aria-label={`「${category.name}」の名前を変更`}
                      onClick={() => {
                        setError(undefined);
                        setInfo(undefined);
                        setEditing({ id: category.id, name: category.name });
                      }}>名前を変更</button>
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ul>
      <form className={styles.inlineForm} onSubmit={add}>
        <input aria-label="追加するカテゴリ名" placeholder="新しいカテゴリ名" value={newName}
          maxLength={CATEGORY_NAME_MAX_LENGTH} disabled={busy} onChange={(event) => setNewName(event.target.value)} />
        <button type="submit" className="secondary-button" disabled={busy || !newName.trim()}>追加</button>
      </form>
      {(busy || info || error) && (
        <div className={styles.categoryMessages}>
          {busy && <LoadingStatus className={styles.status}>保存しています…</LoadingStatus>}
          {info && <p className="view-notice" role="status">{info}</p>}
          {error && <p className={styles.error} role="alert">{error}</p>}
        </div>
      )}
      </div>
    </section>
  );
}
