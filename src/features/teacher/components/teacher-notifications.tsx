import { useState } from "react";
import { LoadingStatus } from "@/components/loading-status";
import { MathTitle } from "@/components/math-title";
import { Dialog } from "@/components/dialog";
import { Icon } from "@/components/icon";
import type { TeacherNotice } from "../hooks/use-teacher-notices.ts";

/** 先生のベル。通知の中身と既読の管理は useTeacherNotices が持つ。 */
export function TeacherNotifications({ notices, unread, loaded, onShow, onOpenThread, onOpenDraft }: {
  notices: TeacherNotice[];
  unread: TeacherNotice[];
  loaded: boolean;
  /** ベルを開いたとき（一覧にあるものを既読にする） */
  onShow: () => void;
  onOpenThread: (id: string) => void;
  onOpenDraft: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // 開いた時点で未読だったもの。開くと既読になるが、開いている間は「新着」と示す。
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  const show = () => {
    setFresh(new Set(unread.map((notice) => notice.key)));
    onShow();
    setOpen(true);
  };

  const openNotice = (notice: TeacherNotice) => {
    setOpen(false);
    if (notice.kind === "thread") onOpenThread(notice.id);
    else onOpenDraft(notice.id);
  };

  return (
    <>
      <button type="button" className="secondary-button notification-button"
        aria-label={unread.length ? `通知、新着${unread.length}件` : "通知"} aria-haspopup="dialog" onClick={show}>
        <Icon name="bell" size={20} />
        {unread.length > 0 && <span className="notification-count" aria-hidden="true">{unread.length}</span>}
      </button>
      {open && (
        <Dialog title="通知" onClose={() => setOpen(false)}>
          {notices.length === 0 ? (loaded ? <p className="empty">対応が必要なものはありません。</p> : <LoadingStatus className="empty">読み込み中です…</LoadingStatus>) : (
            <ul className="item-list">
              {notices.map((notice) => (
                <li key={notice.key}>
                  <button type="button" className="list-button" onClick={() => openNotice(notice)}>
                    <span className="notification-content"><small>{notice.label}</small><strong><MathTitle text={notice.title} /></strong></span>
                    {fresh.has(notice.key) && <span className="badge">新着</span>}
                    <Icon name="arrow" size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Dialog>
      )}
    </>
  );
}
