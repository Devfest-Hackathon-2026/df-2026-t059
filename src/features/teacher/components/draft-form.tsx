import { type FormEvent, type ReactNode, useId, useLayoutEffect, useMemo, useState } from "react";
import { DRAFT_ANSWER_MAX_LENGTH, DRAFT_QUESTION_MAX_LENGTH } from "../../../domain/limits.ts";
import { MessageBody } from "@/components/message-body";
import { MathTitle } from "@/components/math-title";
import type { TeacherWorkflowClient } from "../api/client.ts";
import { isStale, messageOf } from "../api/errors.ts";
import { formatDateTime } from "../format.ts";
import type { CourseCategory, DraftContent, DraftVersionDTO, KnowledgeDraftDTO } from "../workflow-types.ts";
import { AnswerPreview } from "./answer-preview";
import { type DraftTab, draftTabId, DraftTabs } from "./draft-tabs";
import { ConfirmDialog } from "./teacher-dialog";
import styles from "./teacher.module.css";

export type DraftAction = "save" | "select" | "publish" | "dismiss" | "generate" | "restore";

const kindLabels: Record<DraftVersionDTO["kind"], string> = { generated: "AIの案", teacher_edit: "先生の編集" };

const emptyContent: DraftContent = { question: "", answer: "", categoryId: "" };

function contentOf(version: DraftVersionDTO | undefined): DraftContent {
  return version ? { question: version.question, answer: version.answer, categoryId: version.categoryId } : emptyContent;
}

/** 保存・共有で送る形（前後の空白を除く）。 */
function trimContent(content: DraftContent): DraftContent {
  return { question: content.question.trim(), answer: content.answer.trim(), categoryId: content.categoryId };
}

function sameContent(a: DraftContent, b: DraftContent) {
  return a.question === b.question && a.answer === b.answer && a.categoryId === b.categoryId;
}

/**
 * 未公開の候補の確認・編集。選択中の版を編集欄に出し、別の案への切り替え・編集の保存・共有・見送りを行う。
 * 失敗や競合のときも、編集中の内容は残す。
 */
export function DraftForm({ client, draft, categories, busy, setBusy, onDraftChange, onDirtyChange, onFinished, onConflict, source }: {
  client: TeacherWorkflowClient;
  draft: KnowledgeDraftDTO;
  categories: CourseCategory[];
  busy: DraftAction | undefined;
  setBusy: (action: DraftAction | undefined) => void;
  /** 保存・選択・読み直しで受け取った最新の候補 */
  onDraftChange: (draft: KnowledgeDraftDTO) => void;
  /** 編集の元にした版から変わっているか（閉じる前の確認に使う） */
  onDirtyChange: (dirty: boolean) => void;
  onFinished: (notice: string) => void;
  onConflict: () => Promise<void>;
  /** 元の会話。渡すと狭い画面用のタブ表示になる（プレビュー・編集・元の会話） */
  source?: ReactNode;
}) {
  // AI の案を確かめるのが主な流れなので、まず生徒に見える完成形を出す。
  const [tab, setTab] = useState<DraftTab>("preview");
  const panelId = useId();
  // 編集の元にした版。ほかの先生が選択中の版を変えても、こちらの編集の元は変えない。
  const [baseId, setBaseId] = useState(draft.selectedVersionId);
  const base = draft.versions.find((version) => version.id === baseId);
  const [form, setForm] = useState(() => contentOf(base));
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<string>();
  // ほかの先生が共有・見送りした後は、この画面からは操作できない。
  const [locked, setLocked] = useState(false);
  const [selecting, setSelecting] = useState<string>();
  const [confirmingDismiss, setConfirmingDismiss] = useState(false);

  const sortedCategories = useMemo(() => [...categories].sort((a, b) => a.order - b.order), [categories]);
  const validCategory = sortedCategories.some((category) => category.id === form.categoryId);
  const trimmed = trimContent(form);
  const valid = Boolean(trimmed.question && trimmed.answer && validCategory);
  // 入力欄が元の版と違うか（閉じる前の確認と「元に戻す」に使う）。
  const edited = Boolean(base) && !sameContent(form, contentOf(base));
  // 保存して意味のある変更か。前後の空白だけの違いでは、同じ内容の案を増やさない。
  const changed = Boolean(base) && !sameContent(trimmed, trimContent(contentOf(base)));
  const disabled = Boolean(busy) || locked;
  // 新しい順。番号は作成順に振る。
  const versions = draft.versions.map((version, index) => ({ version, number: index + 1 })).reverse();

  // 描画と同時にダイアログへ伝える。useEffect だと、編集直後に閉じる操作をしたとき確認が出ないことがある。
  useLayoutEffect(() => {
    onDirtyChange(edited);
  }, [edited, onDirtyChange]);

  const load = (next: KnowledgeDraftDTO) => {
    onDraftChange(next);
    setBaseId(next.selectedVersionId);
    setForm(contentOf(next.versions.find((version) => version.id === next.selectedVersionId)));
  };

  /** 競合したとき：一覧を取り直し、候補も読み直す。入力内容は残す。 */
  const recover = async (message: string) => {
    void onConflict();
    try {
      const latest = await client.readDraft(draft.questionId);
      if (latest.publication !== "none") {
        setLocked(true);
        setError("ほかの先生がこの候補を共有または見送ったため、この画面からは操作できません。入力内容はコピーできます。");
        return;
      }
      onDraftChange(latest);
      setError(message);
    } catch {
      setError(`${message}最新の候補を読み込めませんでした。`);
    }
  };

  const run = async (kind: DraftAction, action: () => Promise<void>, conflictMessage: string) => {
    if (disabled) return;
    setBusy(kind);
    setError(undefined);
    setInfo(undefined);
    try {
      await action();
    } catch (cause) {
      if (isStale(cause)) {
        await recover(conflictMessage);
      } else {
        setError(messageOf(cause));
      }
    } finally {
      setBusy(undefined);
    }
  };

  const changedByOther = "ほかの先生が候補を更新したため、最新の案の一覧を読み込みました。入力内容は残しています。";

  const save = () => {
    if (!baseId || !changed || !valid) return;
    void run("save", async () => {
      load(await client.saveDraftEdit(draft.questionId, {
        ...trimmed,
        baseVersionId: baseId,
        expectedSelectedVersionId: draft.selectedVersionId,
      }));
      setInfo("編集を保存しました。この内容が選択中の案になりました。");
    }, `${changedByOther}もう一度保存すると、この編集が選択中の案になります。`);
  };

  const select = (versionId: string) => {
    if (edited) return;
    setSelecting(versionId);
    void run("select", async () => {
      load(await client.selectDraftVersion(draft.questionId, {
        versionId,
        expectedSelectedVersionId: draft.selectedVersionId,
      }));
      setInfo("この案を選択中にしました。");
    }, changedByOther);
  };

  const publish = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!baseId || !valid) return;
    void run("publish", async () => {
      await client.publishDraft(draft.questionId, { ...trimmed, versionId: baseId });
      onFinished("講義のQ&Aに共有しました。");
    }, `${changedByOther}内容を確かめてから、もう一度共有してください。`);
  };

  // 直前の作成が失敗していれば、その作り直し（retry）として送る。失敗した作成は案を残さない。
  const lastFailed = draft.lastGeneration?.status === "failed";

  /** AIで別の案を作る。編集中の内容は残し、選択中の版も変えない（案の一覧に追加されるだけ）。 */
  const generate = () => {
    if (edited) return;
    void run("generate", async () => {
      const next = await client.requestDraft(draft.questionId, lastFailed ? "retry" : "regenerate");
      onDraftChange(next);
      if (next.publication !== "none") {
        // 作成中にほかの先生が共有・見送りした。この画面からは操作させない。
        setLocked(true);
        void onConflict();
        setError("ほかの先生がこの候補を共有または見送ったため、この画面からは操作できません。入力内容はコピーできます。");
      } else if (next.lastGeneration?.status === "failed") {
        setError("AIで新しい案を作れませんでした。今ある案はそのまま使えます。");
      } else {
        setInfo("AIの新しい案を案の一覧に追加しました。「この案を使う」で切り替えられます。");
      }
    }, "ほかの先生が新しい案を作成中か、候補の状態が変わりました。最新の候補を読み込みました。");
  };

  const dismiss = () => {
    setConfirmingDismiss(false);
    void run("dismiss", async () => {
      await client.dismissDraft(draft.questionId);
      onFinished("この候補の共有を見送りました。");
    }, changedByOther);
  };

  if (!base) return <p className={styles.status}>確認できる案がまだありません。案ができてから開き直してください。</p>;

  const statusNote = busy === "generate" ? (
    <p className={styles.status} role="status">AIが新しい案を作成中です…</p>
  ) : draft.activeGeneration ? (
    <p className={styles.status} role="status">AIが新しい案を作成中です。できあがると案の一覧に追加されます（開き直すと表示されます）。</p>
  ) : lastFailed && !error && (
    <p className={styles.status} role="status">直近の新しい案の作成に失敗しました。今ある案はそのまま使えます。</p>
  );
  const generateButton = !draft.activeGeneration && !locked && (
    <div className={styles.actionsEnd}>
      <button type="button" className="secondary-button" disabled={disabled || edited} onClick={generate}
        title={edited ? "編集中は新しい案を作れません。保存するか「元に戻す」を押してください。" : undefined}>
        {busy === "generate" ? "AIが作成中…" : lastFailed ? "AIでもう一度案を作る" : "AIで別の案を作る"}
      </button>
    </div>
  );
  const versionList = (
    <>
      <p className={styles.hint}>案を開くと全文が表示され、別の案に切り替えられます。</p>
      <ul className={styles.versionList}>
        {versions.map(({ version, number }) => {
          const selected = version.id === draft.selectedVersionId;
          return (
            <li key={version.id}>
              <details className={styles.versionItem}>
                <summary className={styles.versionSummary}>
                  <span className={styles.versionMeta}>
                    案{number}・{kindLabels[version.kind]}・{formatDateTime(version.createdAt)}
                    {selected && <span className="badge badge--waiting">選択中</span>}
                  </span>
                  <strong><MathTitle text={version.question} /></strong>
                </summary>
                <MessageBody text={version.answer} className={styles.versionAnswer} />
                {!selected && (
                  <div className={styles.actionsEnd}>
                    <button type="button" className="secondary-button" disabled={disabled || edited}
                      onClick={() => select(version.id)}>
                      {busy === "select" && selecting === version.id ? "切り替え中…" : "この案を使う"}
                    </button>
                  </div>
                )}
              </details>
            </li>
          );
        })}
      </ul>
      {edited && <p className={styles.hint}>編集中は案を切り替えられません。保存するか「元に戻す」を押してください。</p>}
    </>
  );
  const titleField = (
    <label>タイトル
      {/* Enter で確認なしに生徒へ共有してしまわないようにする */}
      <input value={form.question} maxLength={DRAFT_QUESTION_MAX_LENGTH} required disabled={disabled}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault();
        }}
        onChange={(event) => setForm({ ...form, question: event.target.value })} />
    </label>
  );
  const answerField = (
    <label>共有する回答
      <textarea rows={5} value={form.answer} maxLength={DRAFT_ANSWER_MAX_LENGTH} required disabled={disabled}
        onChange={(event) => setForm({ ...form, answer: event.target.value })} />
    </label>
  );
  const categoryField = (
    <label>カテゴリ
      <select className={styles.select} value={validCategory ? form.categoryId : ""} required disabled={disabled}
        onChange={(event) => setForm({ ...form, categoryId: event.target.value })}>
        {!validCategory && <option value="" disabled>カテゴリを選んでください</option>}
        {sortedCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
      </select>
    </label>
  );
  const messages = (
    <>
      {info && <p className="view-notice" role="status">{info}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </>
  );
  const dismissButton = (
    <button type="button" className="text-button" onClick={() => setConfirmingDismiss(true)} disabled={disabled}>
      {busy === "dismiss" ? "処理中…" : "見送る"}
    </button>
  );
  const resetButton = (
    <button type="button" className="text-button" disabled={disabled || !edited}
      onClick={() => setForm(contentOf(base))}>元に戻す</button>
  );
  const saveButton = (
    <button type="button" className="secondary-button" disabled={disabled || !changed || !valid} onClick={save}>
      {busy === "save" ? "保存中…" : "編集を保存"}
    </button>
  );
  const publishButton = (
    <button type="submit" className="primary-button" disabled={disabled || !valid}>
      {busy === "publish" ? "共有中…" : "共有する"}
    </button>
  );
  const dismissConfirm = confirmingDismiss && (
    <ConfirmDialog
      title="この候補の共有を見送りますか？"
      body={edited
        ? "見送った候補は生徒に共有されません。あとで「見送った候補」から確認待ちに戻せます。編集中の内容は保存されません。"
        : "見送った候補は生徒に共有されません。あとで「見送った候補」から確認待ちに戻せます。"}
      keepLabel="やめる"
      confirmLabel="見送る"
      onKeep={() => setConfirmingDismiss(false)}
      onConfirm={dismiss}
    />
  );

  if (source !== undefined) {
    const selectedNumber = versions.find(({ version }) => version.id === draft.selectedVersionId)?.number;
    const categoryLabel = sortedCategories.find((category) => category.id === form.categoryId)?.name ?? "カテゴリ未選択";
    return (
      <>
        {/* タブと操作ボタンは常に見え、タブの中身だけがスクロールする。結果の案内もどのタブでも見える下部に出す。 */}
        <form className={styles.tabsLayout} onSubmit={publish}>
          <DraftTabs tab={tab} onChange={setTab} panelId={panelId} />
          <div className={styles.tabPanel} id={panelId} role="tabpanel" aria-labelledby={draftTabId(panelId, tab)}>
            {tab === "preview" && (
              <div className={styles.studentPreview}>
                {!draft.questionResolved && <p className={styles.hint}>この相談は、生徒がまだ解決していません。</p>}
                {edited && <p className={styles.hint}>保存していない編集も反映して表示しています。</p>}
                <span className="subject-label">{categoryLabel}</span>
                <h3 className={styles.studentPreviewTitle}><MathTitle text={form.question.trim() || "（タイトルが未入力です）"} /></h3>
                {form.answer.trim()
                  ? <MessageBody text={form.answer} />
                  : <p className={styles.hint}>回答が未入力です。</p>}
              </div>
            )}
            {tab === "edit" && (
              <div className="dialog-form">
                {statusNote}
                {generateButton}
                {versions.length > 1 && (
                  <details className={styles.versionsToggle}>
                    <summary className={styles.versionsToggleSummary}>案{versions.length}件（選択中：案{selectedNumber}）</summary>
                    {versionList}
                  </details>
                )}
                {titleField}
                {answerField}
                {categoryField}
                <div className={styles.formActions}>
                  {dismissButton}
                  {resetButton}
                </div>
              </div>
            )}
            {tab === "source" && source}
          </div>
          <div className={styles.tabFooter}>
            {messages}
            <div className={styles.tabFooterButtons}>
              {saveButton}
              {publishButton}
            </div>
          </div>
        </form>
        {dismissConfirm}
      </>
    );
  }

  return (
    <>
      <p className="dialog-intro">
        以下のタイトル・回答・カテゴリが、同じ講義の生徒に表示されます。元の会話を見ながら編集できます。
        {!draft.questionResolved && " この相談は、生徒がまだ解決していません。"}
      </p>
      {statusNote}
      {generateButton}
      {versions.length > 1 && (
        <section className={styles.versions} aria-label="案の一覧">
          <h3 className={styles.versionsHeading}>案の一覧（{versions.length}件）</h3>
          {versionList}
        </section>
      )}
      <form className="dialog-form" onSubmit={publish}>
        {titleField}
        {answerField}
        <AnswerPreview text={form.answer} title={form.question} />
        {categoryField}
        {messages}
        <div className={`${styles.formActions} ${styles.stickyActions}`}>
          <div>{dismissButton}</div>
          <div className={styles.formActionsMain}>
            {resetButton}
            {saveButton}
            {publishButton}
          </div>
        </div>
      </form>
      {dismissConfirm}
    </>
  );
}
