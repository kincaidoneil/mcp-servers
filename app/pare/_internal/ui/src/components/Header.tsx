// The status row under the deck: how much is left, undo, fullscreen, and the
// menu. The count goes down rather than up, so the first thing it says is not
// that nothing is done, and each decision visibly takes one off the pile.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ExpandIcon, MoreIcon, UndoIcon } from "./icons";

interface StatusBarProps {
  // Cards still in the stack; nothing is shown once it is empty.
  left: number;
  canUndo: boolean;
  onUndo: () => void;
  fullscreen: boolean;
  canFullscreen: boolean;
  onToggleFullscreen: () => void;
  menu?: ReactNode;
}

export function StatusBar(props: StatusBarProps) {
  return (
    <div className="pare-foot">
      <span className="pare-count" data-testid="progress">
        {props.left === 1 ? "Last one" : props.left > 1 ? `${props.left} left` : null}
      </span>
      <button
        type="button"
        className="pare-icon-btn"
        data-tip="Undo · ⌘Z"
        aria-label="Undo"
        disabled={!props.canUndo}
        onMouseDown={(e) => e.preventDefault()}
        onClick={props.onUndo}
        data-testid="undo"
      >
        <UndoIcon />
      </button>
      {props.canFullscreen && (
        <button
          type="button"
          className="pare-icon-btn"
          data-tip={props.fullscreen ? "Exit full screen" : "Full screen"}
          aria-label={props.fullscreen ? "Exit full screen" : "Full screen"}
          onMouseDown={(e) => e.preventDefault()}
          onClick={props.onToggleFullscreen}
        >
          <ExpandIcon active={props.fullscreen} />
        </button>
      )}
      {props.menu}
    </div>
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

export function Menu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="pare-menu-wrap" ref={ref}>
      <button
        type="button"
        className="pare-icon-btn"
        data-tip="More"
        aria-label="More actions"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        data-testid="menu"
      >
        <MoreIcon />
      </button>
      {open && (
        <div className="pare-menu" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                item.onSelect();
                setOpen(false);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
