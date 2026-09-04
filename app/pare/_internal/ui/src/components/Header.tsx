// The status row under the deck: count, undo, fullscreen, and the menu. Dim
// until hovered; nothing here is needed to make a decision.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ExpandIcon, MoreIcon, UndoIcon } from "./icons";

interface StatusBarProps {
  decided: number;
  total: number;
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
        <b>{props.decided}</b> of {props.total}
      </span>
      <button
        type="button"
        className="pare-icon-btn"
        title="Undo (⌘Z)"
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
          title={props.fullscreen ? "Exit full screen" : "Full screen"}
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
  confirm?: string;
}

export function Menu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setConfirming(null);
  }

  return (
    <div className="pare-menu-wrap" ref={ref}>
      <button
        type="button"
        className="pare-icon-btn"
        aria-label="More actions"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (open ? close() : setOpen(true))}
        data-testid="menu"
      >
        <MoreIcon />
      </button>
      {open && (
        <div className="pare-menu" role="menu">
          {items.map((item, i) =>
            confirming === i ? (
              <div key={item.label} className="pare-menu__confirm">
                <span>{item.confirm}</span>
                <button
                  type="button"
                  onClick={() => {
                    item.onSelect();
                    close();
                  }}
                >
                  Yes
                </button>
                <button type="button" onClick={() => setConfirming(null)}>
                  No
                </button>
              </div>
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  if (item.confirm) {
                    setConfirming(i);
                    return;
                  }
                  item.onSelect();
                  close();
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
