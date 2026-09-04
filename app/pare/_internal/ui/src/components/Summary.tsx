// Shown when the deck is empty: every decision grouped by action, each one
// revisitable, and the button that sends the lot to the chat.

import { DISPOSE, KEEP, actionLabel, type Session } from "../../../schema";

interface SummaryProps {
  session: Session;
  sent: "final" | "progress" | null;
  sending: boolean;
  sendError: string | null;
  canSend: boolean;
  onRevisit: (itemId: string) => void;
  onSend: () => void;
}

export function Summary(props: SummaryProps) {
  const { session } = props;
  const order = [DISPOSE, KEEP, ...session.config.extra_actions.map((a) => a.id)];
  const groups = order
    .map((actionId) => ({
      actionId,
      label: actionLabel(session.config, actionId),
      items: session.config.items.filter((item) => session.decisions[item.id]?.action === actionId),
    }))
    .filter((group) => group.items.length > 0);
  const total = session.config.items.length;
  const tally = groups.map((g) => `${g.items.length} ${g.label.toLowerCase()}`).join(", ");

  return (
    <div className="pare-summary" data-testid="summary">
      <div className="pare-summary__head">
        <div>
          <h2 className="pare-summary__title">All {total} sorted</h2>
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
                  onClick={() => props.onRevisit(item.id)}
                >
                  Revisit
                </button>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
