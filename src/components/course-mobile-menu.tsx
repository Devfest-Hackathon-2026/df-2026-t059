import { type ReactNode, useState } from "react";
import { Dialog } from "./dialog";
import { Icon } from "./icon";

export function CourseMobileMenu({ children }: { children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return <>
    <button type="button" className="secondary-button course-menu-toggle" aria-label="メニューを開く"
      aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><Icon name="menu" size={22} /></button>
    {open && <Dialog title="講義メニュー" className="course-menu-dialog" onClose={close}>
      <div className="sidebar">{children(close)}</div>
    </Dialog>}
  </>;
}
