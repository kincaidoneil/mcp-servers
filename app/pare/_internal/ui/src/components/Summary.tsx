// Shown when the deck is empty, or when the pass was ended with items still
// undecided: every decision grouped by action, each one revisitable, whatever
// was left unsettled, and the button that sends the lot to the chat. It sits
// inline in a conversation, so each group shows its first few rows until
// asked for the rest, and once the hand-off lands the whole list folds away
// behind the receipt.

import { useEffect, useRef, useState } from "react";
import { DISPOSE, KEEP, actionLabel, type Item, type Session } from "../../../schema";
import { CheckIcon, CrossIcon } from "./icons";

const ROWS_SHOWN = 5;

interface SummaryProps {
  session: Session;
  undecided: Item[];
  sent: "final" | "progress" | null;
  sending: boolean;
  sendError: string | null;
  canSend: boolean;
  onRevisit: (itemId: string) => void;
  onResume: (itemId: string) => void;
  onSend: () => void;
}

export function Summary(props: SummaryProps) {
  const { session } = props;
  // The deck held focus in the note field; when it runs out, focus lands here
  // rather than back at the top of the document.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [showList, setShowList] = useState(false);
  const order = [DISPOSE, KEEP, ...session.config.extra_actions.map((a) => a.id)];
  const groups = order
    .map((actionId) => ({
      actionId,
      label: actionLabel(session.config, actionId),
      items: session.config.items.filter((item) => session.decisions[item.id]?.action === actionId),
    }))
    .filter((group) => group.items.length > 0);
  const total = session.config.items.length;
  const left = props.undecided.length;
  const decided = total - left;
  const tally = groups.map((g) => `${g.items.length} ${g.label.toLowerCase()}`).join(", ");
  const sent = props.sent === "final";
  const listed = !sent || showList;

  const expand = (key: string) => setExpanded((prev) => new Set(prev).add(key));
  const shown = (key: string, items: Item[]) =>
    expanded.has(key) ? items : items.slice(0, ROWS_SHOWN);

  return (
    <div className="pare-summary" data-testid="summary">
      <div className="pare-summary__head">
        <div>
          <p className="pare-summary__session">{session.config.title}</p>
          <h2
            className="pare-summary__title"
            ref={heading}
            tabIndex={-1}
            data-testid="summary-title"
          >
            {left === 0 ? `All ${total} sorted` : `${decided} of ${total} sorted`}
          </h2>
          <p className="pare-summary__counts">{tally}</p>
        </div>
        {sent ? null : (
          <button
            type="button"
            className="pare-btn--primary"
            disabled={props.sending || !props.canSend}
            title={props.canSend ? undefined : "This host cannot receive messages from apps"}
            onClick={props.onSend}
            data-testid="send"
          >
            {props.sending ? "Sending…" : props.sendError ? "Try again" : "Send to chat"}
          </button>
        )}
      </div>

      {sent && (
        <div className="pare-receipt" data-testid="sent">
          <span className="pare-receipt__mark" aria-hidden>
            <CheckIcon />
          </span>
          <div>
            <p className="pare-receipt__title">
              Sent to the chat · {decided} {decided === 1 ? "decision" : "decisions"}
            </p>
            <p className="pare-receipt__sub">
              To change one, revisit it and send again.{" "}
              <button
                type="button"
                className="pare-link-btn"
                aria-expanded={showList}
                onClick={() => setShowList((v) => !v)}
                data-testid="toggle-list"
              >
                {showList ? "Hide decisions" : "Show decisions"}
              </button>
            </p>
          </div>
        </div>
      )}
      {props.sendError && (
        <div className="pare-failed" role="alert" data-testid="send-error">
          <span className="pare-failed__mark" aria-hidden>
            <CrossIcon />
          </span>
          <div>
            <p className="pare-failed__title">That didn't reach the chat.</p>
            <p className="pare-failed__sub">
              Your decisions are still here, so nothing is lost.
              <span className="pare-failed__detail"> {props.sendError}</span>
            </p>
          </div>
        </div>
      )}

      {listed &&
        groups.map((group) => (
          <section
            key={group.actionId}
            className={`pare-summary__group pare-summary__group--${group.actionId}`}
          >
            <h3>
              {group.label} <span>{group.items.length}</span>
            </h3>
            {shown(group.actionId, group.items).map((item) => {
              const decision = session.decisions[item.id];
              return (
                <div key={item.id} className="pare-summary__row">
                  <div className="pare-summary__row-text">
                    <div className="pare-summary__row-title">{item.title}</div>
                    {item.subtitle && <div className="pare-summary__row-sub">{item.subtitle}</div>}
                    {decision?.note && (
                      <div className="pare-summary__row-note">{decision.note}</div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="pare-link-btn"
                    aria-label={`Revisit ${item.title}`}
                    onClick={() => props.onRevisit(item.id)}
                  >
                    Revisit
                  </button>
                </div>
              );
            })}
            <More
              hidden={group.items.length - shown(group.actionId, group.items).length}
              onClick={() => expand(group.actionId)}
            />
          </section>
        ))}

      {listed && left > 0 && (
        <section className="pare-summary__group pare-summary__group--undecided">
          <h3>
            Undecided <span>{left}</span>
          </h3>
          {shown("undecided", props.undecided).map((item) => (
            <div key={item.id} className="pare-summary__row">
              <div className="pare-summary__row-text">
                <div className="pare-summary__row-title">{item.title}</div>
                {item.subtitle && <div className="pare-summary__row-sub">{item.subtitle}</div>}
              </div>
              <button
                type="button"
                className="pare-link-btn"
                aria-label={`Decide ${item.title}`}
                onClick={() => props.onResume(item.id)}
                data-testid="resume"
              >
                Decide
              </button>
            </div>
          ))}
          <More
            hidden={left - shown("undecided", props.undecided).length}
            onClick={() => expand("undecided")}
          />
        </section>
      )}
    </div>
  );
}

function More({ hidden, onClick }: { hidden: number; onClick: () => void }) {
  if (hidden <= 0) return null;
  return (
    <button type="button" className="pare-link-btn pare-summary__more" onClick={onClick}>
      Show {hidden} more
    </button>
  );
}
