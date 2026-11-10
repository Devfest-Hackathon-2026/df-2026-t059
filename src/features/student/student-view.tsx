import { type FormEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CourseCategory, StudentThreadActions, SummaryStatus } from "../../domain/course-workflow.ts";
import { MESSAGE_MAX_LENGTH } from "../../domain/limits.ts";
import { Conversation } from "@/components/conversation";
import { CourseMobileMenu } from "@/components/course-mobile-menu";
import { Icon } from "@/components/icon";
import { LoadingStatus, Spinner } from "@/components/loading-status";
import { MathTitle } from "@/components/math-title";
import { MessageBody } from "@/components/message-body";
import { MathInput } from "./math-input";
import { type SharedQuestionView, type StudentThreadView, threadStatus } from "./student-view-model";

export type StudentTab = "chat" | "history" | "shared";

const studentLinks = [
  { id: "chat", label: "新しい質問", icon: "chat" },
  { id: "history", label: "解決済みの質問", icon: "history" },
  { id: "shared", label: "みんなのQ&A", icon: "book" },
] as const;

type MenuProps = {
  tab: StudentTab | "thread";
  inHistory: boolean;
  threads: StudentThreadView[];
  activeId?: string;
  onTab: (tab: StudentTab) => void;
  onOpen: (id: string) => void;
};

export function StudentMenu({ tab, inHistory, threads, activeId, onTab, onOpen }: MenuProps) {
  return <>
    <nav className="student-links" aria-label="生徒メニュー">
      {studentLinks.map(({ id, label, icon }) => (
        <button type="button" key={id} aria-current={(id === "history" ? inHistory : tab === id) ? "page" : undefined}
          onClick={() => onTab(id)}><Icon name={icon} />{label}</button>
      ))}
    </nav>
    <StudentThreadMenu threads={threads} activeId={activeId} onOpen={onOpen} />
  </>;
}

export function StudentMobileMenu({ accountActions, ...menu }: MenuProps & { accountActions?: ReactNode }) {
  return <CourseMobileMenu>{(close) => <>
        <StudentMenu {...menu} onTab={(tab) => { close(); menu.onTab(tab); }}
          onOpen={(id) => { close(); menu.onOpen(id); }} />
        {accountActions}
  </>}</CourseMobileMenu>;
}

const activeThreadGroups: { statuses: StudentThreadView["status"][]; id: string; label: string }[] = [
  { statuses: ["open", "pending"], id: "open", label: "相談中の質問" },
  { statuses: ["waiting"], id: "waiting", label: "先生の回答待ちの質問" },
];

export function isCompletedThread({ status }: StudentThreadView) {
  return status === "resolved" || status === "answered";
}

export function StudentThreadMenu({ threads, activeId, onOpen }: {
  threads: StudentThreadView[];
  activeId: string | undefined;
  onOpen: (id: string) => void;
}) {
  const menuId = useId();
  return (
    <nav className="student-thread-menu" aria-label="未解決の質問">
      {activeThreadGroups.map(({ statuses, id, label }) => {
        const items = threads.filter((thread) => statuses.includes(thread.status));
        const headingId = `${menuId}-${id}`;
        return (
          <section key={id} aria-labelledby={headingId}>
            <h2 id={headingId}>{label}</h2>
            {items.length === 0 ? <p>質問はありません</p> : (
              <ul className="student-thread-list">
                {items.map(({ id, title }) => (
                  <li key={id}>
                    <button type="button" title={title} aria-current={id === activeId ? "page" : undefined} onClick={() => onOpen(id)}>
                      <span className="thread-menu-title"><MathTitle text={title} /></span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </nav>
  );
}

export type StudentChatAction = "resolve" | "escalate";

type ChatProps = {
  thread: StudentThreadView | undefined;
  source?: StudentThreadView;
  sourceNotice?: ReactNode;
  onSend: (text: string) => boolean | undefined | Promise<boolean | undefined>;
  onResolve: () => void;
  onEscalate: () => void;
  onBack?: () => void;
  onStartRelated?: () => void;
  actions?: StudentThreadActions;
  summaryStatus?: SummaryStatus;
  busy?: boolean;
  pendingAction?: StudentChatAction;
  pendingMessage?: { text: string; previousCount: number };
  sharingExcluded?: boolean;
  onRetryAi?: () => void;
  onRetrySummary?: () => void;
  sample?: boolean;
  onRegenerateSummary?: () => void;
  onOpenKnowledge?: (id: string) => void;
  knowledgeTitles?: Record<string, string>;
};

export function StudentChat({ thread, source, sourceNotice, onSend, onResolve, onEscalate, onBack, onStartRelated,
  actions, summaryStatus, busy = false, pendingAction, pendingMessage, sharingExcluded, onRetryAi, onRetrySummary, sample,
  onRegenerateSummary, onOpenKnowledge, knowledgeTitles }: ChatProps) {
  const [text, setText] = useState("");
  const [mathOpen, setMathOpen] = useState(false);
  const [math, setMath] = useState({ value: "", complete: true });
  const scroll = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
  const isPending = thread?.status === "pending" || (pendingMessage !== undefined && thread?.status !== "waiting");
  const canSend = actions?.canSendMessage ?? (!thread || ["open", "answered", "waiting"].includes(thread.status));
  const canCompose = canSend || isPending;
  const isRelatedDraft = Boolean(source && !thread);
  const messages = thread?.messages ?? [];
  const shownMessages = pendingMessage && messages.length <= pendingMessage.previousCount
    ? [...messages, { id: "sending-message", role: "student" as const, text: pendingMessage.text }]
    : messages;
  const messageCount = shownMessages.length + (source?.messages.length ?? 0);
  const formula = mathOpen ? math.value.trim() : "";
  const composed = [text.trim(), formula ? `$$\n${formula}\n$$` : ""].filter(Boolean).join("\n\n");
  const mathIncomplete = Boolean(formula && !math.complete);
  const tooLong = composed.length > MESSAGE_MAX_LENGTH;

  useEffect(() => {
    if (messageCount && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messageCount]);

  useLayoutEffect(() => {
    const field = textarea.current;
    if (!canCompose || !field) return;
    if (!text) {
      field.style.height = "";
      return;
    }
    const resize = () => {
      field.style.height = "auto";
      const borders = field.offsetHeight - field.clientHeight;
      field.style.height = `${field.scrollHeight + borders}px`;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [text, canCompose]);

  useEffect(() => {
    if (isRelatedDraft) textarea.current?.focus();
  }, [isRelatedDraft]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!composed || mathIncomplete || tooLong || !canSend || busy || submitting.current) return;
    submitting.current = true;
    setText("");
    setMath({ value: "", complete: true });
    setMathOpen(false);
    let saved: boolean | undefined = false;
    try {
      saved = await onSend(composed);
    } finally {
      submitting.current = false;
      if (saved === false) {
        setText(text);
        setMath(math);
        setMathOpen(mathOpen);
      }
    }
  };

  return (
    <>
      <div className="view-heading chat-heading">
        {onBack && <button type="button" className="text-button" disabled={busy} onClick={onBack}>質問一覧に戻る</button>}
        <h1><MathTitle text={thread?.title ?? source?.title ?? "新しい質問"} /></h1>
        {thread && <span className={`badge badge--${thread.status}`}>{threadStatus[thread.status]}</span>}
      </div>
      <section className="surface chat-panel" aria-label="質問チャット">
        {(thread || source || pendingMessage !== undefined) && (
          <div className="chat-scroll" ref={scroll}>
            {sourceNotice}
            {source && <>
              <Conversation messages={source.messages} label="元の会話" sample={sample} onOpenKnowledge={onOpenKnowledge} knowledgeTitles={knowledgeTitles} />
              <p className="related-divider">ここから新しい質問</p>
            </>}
            {shownMessages.length > 0 && <Conversation messages={shownMessages} sample={sample} onOpenKnowledge={onOpenKnowledge} knowledgeTitles={knowledgeTitles} />}
            {isPending && <LoadingStatus className="answer-progress">AIが回答を考えています</LoadingStatus>}
          </div>
        )}
        {thread?.status === "resolved" && summaryStatus === undefined && !sharingExcluded && (
          <p className="chat-notice" role="status"><Icon name="check" /> 解決済みになりました。要約候補を先生の「Q&A確認」に送りました。</p>
        )}
        {summaryStatus === "generating" && <LoadingStatus className="chat-notice">共有候補の要約を作成しています。</LoadingStatus>}
        {sharingExcluded && summaryStatus !== "published" && <p className="chat-notice"><Icon name="check" />解決済み · 非共有</p>}
        {summaryStatus === "ready" && <p className="chat-notice" role="status">共有候補を先生の確認に送りました。</p>}
        {summaryStatus === "published" && <p className="chat-notice" role="status">先生が確認したQ&Aが公開されています。</p>}
        {actions?.canRetrySummary && onRetrySummary && (
          <div className="student-recovery" role="status">
            <p>要約の作成に失敗しました。会話と解決の状態は保存されています。</p>
            <button type="button" className="secondary-button" disabled={busy} onClick={onRetrySummary}>要約を再試行</button>
          </div>
        )}
        {actions?.canRetryAi && onRetryAi && (
          <div className="student-recovery" role="status">
            <p>AIの回答を取得できませんでした。送信した質問は保存されています。</p>
            <button type="button" className="secondary-button" disabled={busy} onClick={onRetryAi}>AIの回答を再試行</button>
          </div>
        )}
        {onRegenerateSummary && !sharingExcluded && summaryStatus && summaryStatus !== "none" && (
          <div className="summary-actions">
            <p>会話の最新内容を反映した別案を先生に送れます。</p>
            <button type="button" className="secondary-button" disabled={busy || !actions?.canRequestRegeneration}
              onClick={onRegenerateSummary}>共有候補の別案を作る</button>
          </div>
        )}
        {thread?.status === "waiting" && (
          <p className="chat-notice chat-notice--waiting" role="status"><Icon name="history" /> {sample
            ? "先生に引き継ぎました。回答が届くと、画面上部のベルに通知が表示されます。"
            : "先生の回答を待っています。伝えたいことがあれば、ここから補足できます。"}</p>
        )}
        {canCompose && (
          <div className="chat-footer">
            <form className="compose" onSubmit={submit}>
              <div className="compose-fields">
                <label className="visually-hidden" htmlFor="student-question">質問を入力</label>
                <textarea id="student-question" ref={textarea} rows={2} value={text} maxLength={MESSAGE_MAX_LENGTH} disabled={busy}
                  onChange={(event) => setText(event.target.value)}
                  placeholder={thread?.status === "waiting" ? "先生に伝えたいことを補足する" : thread || source ? "続けて質問する" : "質問を書いてみる"} />
                {mathOpen && <MathInput value={math.value} disabled={busy}
                  onChange={(value, complete) => setMath({ value, complete })}
                  onRemove={() => { setMath({ value: "", complete: true }); setMathOpen(false); }} />}
                {mathIncomplete && <p className="compose-error" role="alert">数式の空欄を埋めるか、数式を削除してください。</p>}
                {tooLong && <p className="compose-error" role="alert">送信できる長さを超えています。文章または数式を短くしてください。</p>}
              </div>
              <button type="submit" className="primary-button send-button" aria-label="送信" disabled={!canSend || busy || !composed || mathIncomplete || tooLong}><Icon name="send" size={22} /></button>
            </form>
            {!mathOpen && <div className="compose-options"><button type="button" className="secondary-button" disabled={busy}
              onClick={() => setMathOpen(true)}>数式を入力</button></div>}
            {thread && canSend && (
              <div className="chat-actions">
                {(pendingAction === "escalate" || (actions?.canEscalate ?? thread.status !== "waiting")) && (
                  <button type="button" className="secondary-button" disabled={busy} onClick={onEscalate}>
                    {pendingAction === "escalate" ? <><Spinner /> 先生に相談中…</> : "解決しなかった · 先生に相談"}
                  </button>
                )}
                <button type="button" className="secondary-button resolve-button" disabled={busy || (actions !== undefined && !actions.canResolve)} onClick={onResolve}>
                  {pendingAction === "resolve" ? <><Spinner /> 解決処理中…</> : <><Icon name="check" size={16} /> 解決した</>}
                </button>
              </div>
            )}
          </div>
        )}
      </section>
      {onStartRelated && (
        <button type="button" className="secondary-button related-question-action" disabled={busy} onClick={onStartRelated}>
          <Icon name="chat" size={16} /> この会話から新しい質問
        </button>
      )}
    </>
  );
}

type QuestionFilters = { query: string; category: string };
export const emptyQuestionFilters: QuestionFilters = { query: "", category: "" };

function QuestionFilterControls({ filters, onFilter, categories }: {
  filters: QuestionFilters;
  onFilter: (filters: QuestionFilters) => void;
  categories: readonly Pick<CourseCategory, "id" | "name">[];
}) {
  return (
    <div className="question-filters">
      <label>キーワード検索
        <input type="search" value={filters.query} onChange={(event) => onFilter({ ...filters, query: event.target.value })} placeholder="キーワードを入力" />
      </label>
      <label>カテゴリ
        <select value={filters.category} onChange={(event) => onFilter({ ...filters, category: event.target.value })}>
          <option value="">すべてのカテゴリ</option>
          {categories.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
    </div>
  );
}

export function StudentHistory({ threads, filters, onFilter, onOpen, categories }: {
  threads: StudentThreadView[];
  filters: QuestionFilters;
  onFilter: (filters: QuestionFilters) => void;
  onOpen: (id: string) => void;
  categories: readonly Pick<CourseCategory, "id" | "name">[];
}) {
  const completedThreads = threads.filter(isCompletedThread);
  const keyword = filters.query.trim().toLowerCase();
  const matches = completedThreads.filter(({ categoryIds, title, messages }) => (
    (!filters.category || categoryIds.some((id) => id === filters.category))
    && (!keyword || title.toLowerCase().includes(keyword) || messages.some(({ text }) => text.toLowerCase().includes(keyword)))
  ));
  return (
    <>
      <div className="view-heading">
        <h1>解決済みの質問</h1>
        <p>解決した質問と、先生が回答した質問を確認できます。</p>
      </div>
      <QuestionFilterControls filters={filters} onFilter={onFilter} categories={categories} />
      {matches.length === 0 ? (
        <p className="surface empty">{completedThreads.length ? "条件に合う質問が見つかりませんでした。" : "解決済み・先生が回答済みの質問はありません。"}</p>
      ) : (
        <ul className="surface item-list">
          {matches.map((thread) => (
            <li key={thread.id}>
              <button type="button" className="list-button" onClick={() => onOpen(thread.id)}>
                <span className="item-mark"><Icon name="chat" /></span>
                <strong><MathTitle text={thread.title} /></strong>
                <span className={`badge badge--${thread.status}`}>{threadStatus[thread.status]}</span>
                <Icon name="arrow" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function SharedQuestions({ shared, categories }: {
  shared: SharedQuestionView[];
  categories: readonly Pick<CourseCategory, "id" | "name">[];
}) {
  const [filters, setFilters] = useState(emptyQuestionFilters);
  const keyword = filters.query.trim().toLowerCase();
  const filtered = shared.filter(({ title, answer, categoryId }) => (
    (!filters.category || categoryId === filters.category) && `${title} ${answer}`.toLowerCase().includes(keyword)
  ));
  return (
    <>
      <div className="view-heading">
        <h1>みんなのQ&amp;A</h1>
      </div>
      <QuestionFilterControls filters={filters} onFilter={setFilters} categories={categories} />
      <div className="qa-list">
        {filtered.map((item) => (
          <details key={item.id} className="surface shared-item">
            <summary><span className="item-mark">Q</span><strong><MathTitle text={item.title} /></strong></summary>
            <MessageBody text={item.answer} className="shared-answer" />
          </details>
        ))}
        {filtered.length === 0 && <p className="surface empty">該当するQ&amp;Aが見つかりませんでした。</p>}
      </div>
    </>
  );
}
