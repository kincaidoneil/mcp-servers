// One item rendered as a paper card. Presentation only; the stack owns the
// motion and the overlays (stamps), which it passes in as children.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { DISPOSE, KEEP, actionLabel, type Item, type SessionConfig } from "../../../schema";
import { ChevronIcon } from "./icons";

interface CardProps {
  item: Item;
  config: SessionConfig;
  expanded: boolean;
  onToggleExpanded?: () => void;
  onOpenLink?: (url: string) => void;
  onOverflow?: (overflows: boolean) => void;
  children?: ReactNode;
}

export function Card({
  item,
  config,
  expanded,
  onToggleExpanded,
  onOpenLink,
  onOverflow,
  children,
}: CardProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => {
      const value = el.scrollHeight > el.clientHeight + 2;
      setOverflows(value);
      onOverflow?.(value);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, expanded]);

  const paragraphs = (item.body ?? "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const suggestion = item.suggestion;
  const suggestionTone =
    suggestion?.action === KEEP ? "keep" : suggestion?.action === DISPOSE ? "dispose" : "neutral";
  const showMore = onToggleExpanded && (overflows || expanded);

  return (
    <>
      {children}
      <div className="pare-card__head">
        <span className="pare-card__subtitle">{item.subtitle ?? ""}</span>
        {item.tags && item.tags.length > 0 && (
          <span className="pare-card__tags">
            {item.tags.slice(0, 3).map((tag) => (
              <span key={tag} className="pare-tag">
                {tag}
              </span>
            ))}
          </span>
        )}
      </div>
      <h2 className="pare-card__title">
        {item.url && onOpenLink ? (
          <a
            href={item.url}
            onClick={(e) => {
              e.preventDefault();
              onOpenLink(item.url!);
            }}
          >
            {item.title}
          </a>
        ) : (
          item.title
        )}
      </h2>
      {paragraphs.length > 0 && (
        <div
          ref={bodyRef}
          className={
            "pare-card__body " +
            (expanded ? "pare-card__body--scroll" : overflows ? "pare-card__body--clamped" : "")
          }
        >
          {paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      )}
      <div className="pare-card__foot">
        {item.meta && item.meta.length > 0 && !expanded && (
          <dl className="pare-meta">
            {item.meta.slice(0, 4).map((m) => (
              <MetaRow key={m.label} label={m.label} value={m.value} />
            ))}
          </dl>
        )}
        {(suggestion || showMore) && (
          <div className="pare-card__row">
            {suggestion ? (
              <span className="pare-suggest" title={suggestion.reason}>
                <span className={`pare-suggest__chip pare-suggest__chip--${suggestionTone}`}>
                  Suggested: {actionLabel(config, suggestion.action)}
                </span>
                {suggestion.reason && (
                  <span className="pare-suggest__reason">{suggestion.reason}</span>
                )}
              </span>
            ) : (
              <span />
            )}
            {showMore && (
              <button
                type="button"
                className="pare-more"
                onMouseDown={(e) => e.preventDefault()}
                onClick={onToggleExpanded}
              >
                {expanded ? "Show less" : "Show more"}
                <ChevronIcon up={expanded} />
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </>
  );
}
