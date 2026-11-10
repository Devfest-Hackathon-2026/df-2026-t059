import { useState } from "react";
import { Dialog } from "@/components/dialog";
import { Icon } from "@/components/icon";
import { LoadingStatus } from "@/components/loading-status";
import { MathTitle } from "@/components/math-title";
import type { TeacherReplyNotice } from "./student-view-model";

export function StudentNotifications({ notices, onOpen, loading = false, error, onReload }: {
  notices: TeacherReplyNotice[];
  onOpen: (notice: TeacherReplyNotice) => Promise<void>;
  loading?: boolean;
  error?: string;
  onReload?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const [failedNotice, setFailedNotice] = useState<TeacherReplyNotice>();
  const [reloading, setReloading] = useState(false);
  const unread = notices.filter((notice) => !notice.read).length;

  async function openNotice(notice: TeacherReplyNotice) {
    if (reading) return;
    setReading(true);
    setFailedNotice(undefined);
    try {
      await onOpen(notice);
      setOpen(false);
    } catch {
      setFailedNotice(notice);
    } finally {
      setReading(false);
    }
  }

  async function reload() {
    setReloading(true);
    try { await onReload?.(); }
    finally { setReloading(false); }
  }

  return (
    <>
      <button type="button" className="secondary-button notification-button" aria-label={unread ? `通知、未読${unread}件` : "通知"}
        aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Icon name="bell" size={20} />
        {unread > 0 && <span className="notification-count" aria-hidden="true">{unread}</span>}
      </button>
      {open && (
        <Dialog title="通知" busy={reading} onClose={() => setOpen(false)}>
          {failedNotice && <div className="student-error" role="alert"><p>通知を既読にできませんでした。</p>
            <button type="button" className="secondary-button" onClick={() => void openNotice(failedNotice)}>既読を再試行</button>
          </div>}
          {error && !reloading && <div className="student-error" role="alert"><p>{error}</p>
            {onReload && <button type="button" className="secondary-button" onClick={() => void reload()}>再読み込み</button>}
          </div>}
          {reading && <LoadingStatus>通知を既読にしています…</LoadingStatus>}
          {loading || reloading ? <LoadingStatus>通知を読み込んでいます。</LoadingStatus> : notices.length === 0 && !error ? <p className="empty">通知はありません。</p> : (
            <ul className="item-list">
              {notices.map((notice) => (
                <li key={notice.id}>
                  <button type="button" className="list-button" disabled={reading} onClick={() => void openNotice(notice)}>
                    <span className="notification-content"><small>先生から回答が届きました</small><strong><MathTitle text={notice.title} /></strong></span>
                    {!notice.read && <span className="badge">未読</span>}
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
