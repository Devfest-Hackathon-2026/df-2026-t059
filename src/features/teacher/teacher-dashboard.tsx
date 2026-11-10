"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CourseMobileMenu } from "@/components/course-mobile-menu";
import { Icon } from "@/components/icon";
import { Spinner } from "@/components/loading-status";
import { MathTitle } from "@/components/math-title";
import { createHttpTeacherClient, type TeacherWorkflowClient } from "./api/client.ts";
import { CourseSettings } from "./components/course-settings";
import { DraftReview } from "./components/draft-review";
import { LoadError } from "./components/load-error";
import { PublishedKnowledge } from "./components/published-knowledge";
import { QuestionBoard } from "./components/question-board";
import { TeacherNotifications } from "./components/teacher-notifications";
import { needsReply, useTeacherLists } from "./hooks/use-teacher-lists.ts";
import { useTeacherLocation } from "./hooks/use-teacher-location.ts";
import { useTeacherNotices } from "./hooks/use-teacher-notices.ts";
import type { TeacherView } from "./teacher-location.ts";
import type { CourseCategory, CourseViewDTO, InviteDTO } from "./workflow-types.ts";

const links = [
  { id: "board", label: "質問対応", icon: "board" },
  { id: "review", label: "Q&A確認", icon: "book" },
  { id: "published", label: "共有済みQ&A", icon: "check" },
  { id: "settings", label: "講義の設定", icon: "settings" },
] as const;

/**
 * `client` は固定データでの確認用。省略すると教員用のAPI（docs/implementation/b-teacher.md）を呼ぶ。
 * `headerActions` は見出し行に並べるリンクなど（生徒画面の StudentDashboard と同じ形）。
 */
export function TeacherDashboard({ course, client, headerActions }: {
  course: CourseViewDTO;
  client?: TeacherWorkflowClient;
  headerActions?: ReactNode;
}) {
  const workflow = useMemo(() => client ?? createHttpTeacherClient(course.id), [client, course.id]);
  const { lists, error, refresh, loading } = useTeacherLists(workflow);
  const { location, showView, openItem, closeItem } = useTeacherLocation();
  const tab = location.view;
  const { notices, unread: unreadNotices, loaded: noticesLoaded, markAllSeen, acknowledge } =
    useTeacherNotices(course.id, lists, location.question ?? location.dismissed);
  const [notice, setNotice] = useState("");
  // タブが変わったら（ブラウザの戻る・進むを含む）前のタブの通知を消す。
  const [noticeTab, setNoticeTab] = useState(tab);
  if (noticeTab !== tab) {
    setNoticeTab(tab);
    setNotice("");
  }
  // 定期的には取り直さない一覧（回答済み・見送り・共有済み）も、タブを開いたときに最新にする。
  const refreshedTab = useRef(tab);
  useEffect(() => {
    if (refreshedTab.current === tab) return;
    refreshedTab.current = tab;
    void refresh();
  }, [tab, refresh]);
  // 設定画面での追加・変更を、ほかの画面のカテゴリ名と選択肢にすぐ反映する。
  const [categories, setCategories] = useState<CourseCategory[]>(course.categories);
  // 参加コードは発行した直後しか受け取れないため、設定タブを離れても失わないようここで持つ。
  const [issuedInvite, setIssuedInvite] = useState<InviteDTO>();

  const categoryName = useCallback(
    (id: string | undefined) => categories.find((category) => category.id === id)?.name ?? "未分類",
    [categories],
  );
  // 開いて確認できる候補（案が1つ以上ある）だけを数える。Q&A確認の一覧の件数と揃える。
  const draftCount = lists.drafts?.filter((draft) => draft.question !== null).length ?? 0;
  const waitingCount = lists.escalated?.filter(needsReply).length ?? 0;
  const hasData = Object.values(lists).some(Boolean);
  function selectView(view: TeacherView) {
    setNotice("");
    if (view === tab) void refresh();
    else showView(view);
  }

  const renderMenu = (onSelect: (view: TeacherView) => void) => (
    <nav aria-label="先生メニュー">
      {links.map(({ id, label, icon }) => (
        <button type="button" key={id} aria-current={tab === id ? "page" : undefined} onClick={() => onSelect(id)}>
          <Icon name={icon} />{label}
          {id === "board" && waitingCount > 0 && <span className="nav-count">{waitingCount}</span>}
          {id === "review" && draftCount > 0 && <span className="nav-count">{draftCount}</span>}
        </button>
      ))}
    </nav>
  );

  return (
    <>
    <header className="student-heading">
      <CourseMobileMenu>{(close) => <>
        {renderMenu((view) => { close(); selectView(view); })}
        {headerActions}
      </>}</CourseMobileMenu>
      <h1><MathTitle text={course.name} /></h1>
      <div className="student-heading-actions">
        <div className="student-refresh" role="status">{loading && <><Spinner /><span className="visually-hidden">一覧を更新中</span></>}</div>
        <TeacherNotifications notices={notices} unread={unreadNotices} loaded={noticesLoaded} onShow={markAllSeen}
          onOpenThread={(question) => openItem({ question }, "board")}
          onOpenDraft={(question) => openItem({ question }, "review")} />
        <div className="course-account-actions">{headerActions}</div>
      </div>
    </header>
    <div className="workspace student-workspace">
      <aside className="sidebar course-sidebar" aria-label="講義メニュー">
        {renderMenu(selectView)}
      </aside>
      <section className="main-content" aria-label="教員画面">
        {error && (
          <LoadError message={hasData ? `最新の一覧を取得できませんでした。${error}` : error} onRetry={refresh} />
        )}
        {notice && <p className="view-notice" role="status"><Icon name="check" /> {notice}</p>}
        {tab === "board" ? (
          <QuestionBoard client={workflow} lists={lists} failed={Boolean(error)} categoryName={categoryName}
            refresh={refresh} setNotice={setNotice} selectedId={location.question}
            onOpen={(question) => openItem({ question })} onClose={closeItem} />
        ) : tab === "review" ? (
          <DraftReview client={workflow} lists={lists} failed={Boolean(error)} categories={categories}
            categoryName={categoryName} refresh={refresh} setNotice={setNotice}
            selectedId={location.question} dismissedId={location.dismissed}
            onOpen={(question) => openItem({ question })} onOpenDismissed={(dismissed) => openItem({ dismissed })}
            onOpenThread={(question) => openItem({ question }, "board")} onClose={closeItem} />
        ) : tab === "published" ? (
          <PublishedKnowledge
            client={workflow}
            items={lists.published}
            failed={Boolean(error)}
            categories={categories}
            categoryName={categoryName}
            refresh={refresh}
            setNotice={setNotice}
            onOpenDraft={(question) => openItem({ question }, "review")}
            onDraftReturned={acknowledge}
          />
        ) : (
          <CourseSettings client={workflow} courseId={course.id} categories={categories} onCategoriesChange={setCategories}
            issuedInvite={issuedInvite} onIssued={setIssuedInvite} />
        )}
      </section>
    </div>
    </>
  );
}
