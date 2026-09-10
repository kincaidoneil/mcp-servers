// Shown when the deck is empty, or when the pass was ended with items still
// undecided: every decision grouped by action, each one revisitable, whatever
// was left unsettled, and the button that sends the lot to the chat.

import { useEffect, useRef } from "react";
import { DISPOSE, KEEP, actionLabel, type Item, type Session } from "../../../schema";

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
  const tally = groups.map((g) => `${g.items.length} ${g.label.toLowerCase()}`).join(", ");

  return (
    <div className="pare-summary" data-testid="summary">
      <div className="pare-summary__head">
        <div>
          <h2
            className="pare-summary__title"
            ref={heading}
            tabIndex={-1}
            data-testid="summary-title"
          >
            {left === 0 ? `All ${total} sorted` : `${total - left} of ${total} sorted`}
          </h2>
          <p className="pare-summary__counts">{tally}</p>
        </div>
        {props.sent === "final" ? null : (
          <button
            type="button"
            className="pare-btn--primary"
            disabled={props.sending || !props.canSend}
            title={props.canSend ? undefined : "This host cannot receive messages from apps"}
            onClick={props.onSend}
            data-testid="send"
          >
            {props.sending ? "Sending…" : "Send to chat"}
          </button>
        )}
      </div>

      {props.sent === "final" && (
        <div className="pare-sent" data-testid="sent">
          Sent to the chat. Revisit anything below to change it, then send again.
        </div>
      )}
      {props.sendError && (
        <div className="pare-sent pare-status--error" role="alert">
          {props.sendError}
        </div>
      )}

      {groups.map((group) => (
        <section
          key={group.actionId}
          className={`pare-summary__group pare-summary__group--${group.actionId}`}
        >
          <h3>
            {group.label} <span>{group.items.length}</span>
          </h3>
          {group.items.map((item) => {
            const decision = session.decisions[item.id];
            return (
              <div key={item.id} className="pare-summary__row">
                <div className="pare-summary__row-text">
                  <div className="pare-summary__row-title">{item.title}</div>
                  {item.subtitle && <div className="pare-summary__row-sub">{item.subtitle}</div>}
                  {decision?.note && <div className="pare-summary__row-note">{decision.note}</div>}
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
        </section>
      ))}

      {left > 0 && (
        <section className="pare-summary__group pare-summary__group--undecided">
          <h3>
            Undecided <span>{left}</span>
          </h3>
          {props.undecided.map((item) => (
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
        </section>
      )}
    </div>
  );
}
