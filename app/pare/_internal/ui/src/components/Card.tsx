// One item as a slide on the light table: a title, one quiet line of source
// and facts, and a short body. Presentation only; the stack owns motion and
// the edge marks, which it passes in as children.

import type { ReactNode } from "react";
import type { Item } from "../../../schema";

const FACTS_SHOWN = 3;

interface CardProps {
  item: Item;
  onOpenLink?: (url: string) => void;
  children?: ReactNode;
}

export function Card({ item, onOpenLink, children }: CardProps) {
  const paragraphs = (item.body ?? "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const facts = [
    item.subtitle,
    ...(item.meta ?? []).slice(0, FACTS_SHOWN).map((m) => `${m.label} ${m.value}`),
  ].filter((f): f is string => Boolean(f));

  return (
    <>
      {children}
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
      {facts.length > 0 && <p className="pare-card__meta">{facts.join(" · ")}</p>}
      {paragraphs.length > 0 && (
        <div className="pare-card__body">
          {paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      )}
    </>
  );
}
