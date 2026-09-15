// One item as a slide on the light table: title, source, a short body, and
// up to three facts pinned to the bottom edge. Every slide is the same size,
// so nothing around it moves between cards. Presentation only; the stack
// owns motion and the edge marks, which it passes in as children.

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
  const facts = (item.meta ?? []).slice(0, FACTS_SHOWN);

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
      {item.subtitle && <p className="pare-card__source">{item.subtitle}</p>}
      {paragraphs.length > 0 && (
        <div className="pare-card__body">
          {paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      )}
      {facts.length > 0 && (
        <dl className="pare-facts">
          {facts.map((fact) => (
            <div key={fact.label} className="pare-facts__row">
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}
