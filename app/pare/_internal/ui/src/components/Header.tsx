import { useEffect, useRef, useState, type ReactNode } from "react";
import { ExpandIcon, MoreIcon, UndoIcon } from "./icons";

interface HeaderProps {
  title: string;
  description?: string;
  decided: number;
  total: number;
  canUndo: boolean;
  onUndo: () => void;
  fullscreen: boolean;
  canFullscreen: boolean;
  onToggleFullscreen: () => void;
  menu?: ReactNode;
}

export function Header(props: HeaderProps) {
  const { decided, total } = props;
  const pct = total === 0 ? 0 : Math.round((decided / total) * 100);
  return (
    <>
      <header className="pare-header">
        <div className="pare-header__text">
          <h1 className="pare-header__title">{props.title}</h1>
          {props.description && <p className="pare-header__desc">{props.description}</p>}
        </div>
        <div className="pare-header__side">
          <span className="pare-count" data-testid="progress">
            <b>{decided}</b> of {total}
          </span>
          <button
            type="button"
            className="pare-icon-btn"
            title="Undo (⌘Z)"
            aria-label="Undo"
            disabled={!props.canUndo}
            style={{ opacity: props.canUndo ? 1 : 0.35 }}
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
      </header>
      <div className="pare-bar" aria-hidden>
        <div className="pare-bar__fill" style={{ width: `${pct}%` }} />
      </div>
    </>
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
