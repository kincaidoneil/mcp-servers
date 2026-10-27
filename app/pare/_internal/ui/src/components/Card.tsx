// One item as a slide on the light table: the title, a short body, and one
// quiet line at the foot with where it came from and up to three facts. Two
// things to read and one to glance at. Every slide is the same size, so
// nothing around it moves between cards; an item with only a title sits in
// the middle of it rather than in a corner. Presentation only; the stack owns
// motion and the edge marks, which it passes in as children.

import { Fragment, type ReactNode } from "react";
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
      {paragraphs.length > 0 && (
        <div className="pare-card__body">
          {paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      )}
      {(item.subtitle || facts.length > 0) && (
        <p className="pare-card__meta">
          {item.subtitle && <span>{item.subtitle}</span>}
          {facts.map((fact) => (
            // The space before each fact is where the line may break.
            <Fragment key={fact.label}>
              {" "}
              <span>
                {fact.label} <b>{fact.value}</b>
              </span>
            </Fragment>
          ))}
        </p>
      )}
    </>
  );
}
