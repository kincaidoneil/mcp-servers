// The actions around the slide. The two outcomes sit at the left and right of
// the card in their colors and brighten as the card is dragged their way.
// Later and the extra actions sit under the card as dim text with digits.
// The suggested action carries an amber dot; amber means "suggested" and
// nothing else. Every control names its key in a hover tooltip.

import { motion, useTransform, type MotionValue } from "motion/react";
import { DISPOSE, KEEP, type SessionConfig } from "../../../schema";

const stop = (e: React.MouseEvent) => e.preventDefault();

interface SideActionProps {
  kind: "keep" | "dispose";
  config: SessionConfig;
  suggested: boolean;
  // 0 at rest, 1 when the card has reached this side's commit distance.
  pull: MotionValue<number>;
  onAction: (actionId: string) => void;
}

export function SideAction({ kind, config, suggested, pull, onAction }: SideActionProps) {
  const action = kind === "keep" ? config.keep : config.dispose;
  const id = kind === "keep" ? KEEP : DISPOSE;
  const opacity = useTransform(pull, [0, 1], [0.8, 1]);
  const keys = kind === "keep" ? "→ or Enter" : "←";
  return (
    <div className={`pare-side pare-side--${kind}`}>
      <motion.button
        type="button"
        className="pare-side__btn"
        style={{ opacity }}
        data-tip={action.hint ? `${keys} · ${action.hint}` : keys}
        aria-label={`${action.label}, ${keys}`}
        onMouseDown={stop}
        onClick={() => onAction(id)}
        data-testid={`action-${kind}`}
      >
        <span className="pare-side__arrow" aria-hidden>
          {kind === "keep" ? "→" : "←"}
          {suggested && <SuggestedDot />}
        </span>
        <span className="pare-side__label">{action.label}</span>
      </motion.button>
    </div>
  );
}

interface ExtraActionsProps {
  config: SessionConfig;
  canSkip: boolean;
  suggestedAction: string | undefined;
  onAction: (actionId: string) => void;
  onSkip: () => void;
}

export function ExtraActions(props: ExtraActionsProps) {
  const { config } = props;
  if (!config.skip && config.extra_actions.length === 0) return null;
  return (
    <div className="pare-extras" role="group" aria-label="More actions">
      {config.skip && (
        <button
          type="button"
          className="pare-extra"
          data-tip="↓ · move to the bottom of the deck"
          aria-label="Later, down arrow"
          disabled={!props.canSkip}
          onMouseDown={stop}
          onClick={props.onSkip}
          data-testid="action-skip"
        >
          <span className="pare-extra__key" aria-hidden>
            ↓
          </span>
          Later
        </button>
      )}
      {config.extra_actions.map((action, i) => (
        <button
          key={action.id}
          type="button"
          className="pare-extra"
          data-tip={action.hint ? `${i + 1} · ${action.hint}` : `${i + 1}`}
          aria-label={`${action.label}, ${i + 1}`}
          onMouseDown={stop}
          onClick={() => props.onAction(action.id)}
          data-testid={`action-${action.id}`}
        >
          <span className="pare-extra__key" aria-hidden>
            {i + 1}
          </span>
          {action.label}
          {props.suggestedAction === action.id && <SuggestedDot />}
        </button>
      ))}
    </div>
  );
}

function SuggestedDot() {
  return <span className="pare-suggested" title="Suggested" aria-label="suggested" />;
}
