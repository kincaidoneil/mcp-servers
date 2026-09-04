// The actions around the slide. The two outcomes sit at the left and right of
// the card as discs in their colors, a tick to keep and a cross to dispose,
// and they swell as the card comes toward them. Between them, one row of
// text: the extra buckets with their digit, then Later a step dimmer, since
// it only moves the card. The model's
// suggestion is a blue sparkle next to the action it points at, and blue means
// that and nothing else, and it says why on hover. The two outcomes carry
// their arrow key in the label, pointing the way the card goes.

import { motion, useTransform, type MotionValue } from "motion/react";
import { DISPOSE, KEEP, type SessionConfig } from "../../../schema";
import { CheckIcon, CrossIcon, SparkleIcon } from "./icons";

const stop = (e: React.MouseEvent) => e.preventDefault();

interface SideActionProps {
  kind: "keep" | "dispose";
  config: SessionConfig;
  suggested: boolean;
  // Why the model suggests it, if it said. Shown on hover, never in the row.
  reason: string | undefined;
  // 0 at rest, 1 when the card has reached this side's commit distance.
  pull: MotionValue<number>;
  onAction: (actionId: string) => void;
}

export function SideAction({ kind, config, suggested, reason, pull, onAction }: SideActionProps) {
  const action = kind === "keep" ? config.keep : config.dispose;
  const id = kind === "keep" ? KEEP : DISPOSE;
  const opacity = useTransform(pull, [0, 1], [0.86, 1]);
  const scale = useTransform(pull, [0, 1], [1, 1.12]);
  const keys = kind === "keep" ? "→ or Enter" : "←";
  return (
    <div className={`pare-side pare-side--${kind}`}>
      <motion.button
        type="button"
        className="pare-side__btn"
        style={{ opacity }}
        aria-label={`${action.label}, ${keys}`}
        onMouseDown={stop}
        onClick={() => onAction(id)}
        data-testid={`action-${kind}`}
      >
        <motion.span className="pare-side__mark" style={{ scale }} aria-hidden>
          {kind === "keep" ? <CheckIcon /> : <CrossIcon />}
        </motion.span>
        <span className="pare-side__label">
          {kind === "dispose" && (
            <kbd className="pare-key" aria-hidden>
              ←
            </kbd>
          )}
          {action.label}
          {kind === "keep" && (
            <kbd className="pare-key" aria-hidden>
              →
            </kbd>
          )}
        </span>
        <span className="pare-side__slot">{suggested && <Suggested reason={reason} />}</span>
      </motion.button>
    </div>
  );
}

interface ExtraActionsProps {
  config: SessionConfig;
  canSkip: boolean;
  suggestedAction: string | undefined;
  suggestedReason: string | undefined;
  onAction: (actionId: string) => void;
  onSkip: () => void;
}

export function ExtraActions(props: ExtraActionsProps) {
  const { config } = props;
  if (!config.skip && config.extra_actions.length === 0) return null;
  return (
    <div className="pare-extras" role="group" aria-label="More actions">
      {config.extra_actions.length > 0 && (
        <div className="pare-buckets">
          {config.extra_actions.map((action, i) => (
            <button
              key={action.id}
              type="button"
              className="pare-bucket"
              aria-label={`${action.label}, ${i + 1}`}
              onMouseDown={stop}
              onClick={() => props.onAction(action.id)}
              data-testid={`action-${action.id}`}
            >
              <kbd className="pare-key" aria-hidden>
                {i + 1}
              </kbd>
              {action.label}
              {props.suggestedAction === action.id && <Suggested reason={props.suggestedReason} />}
            </button>
          ))}
        </div>
      )}
      {config.skip && (
        <button
          type="button"
          className="pare-later"
          aria-label="Later, down arrow"
          disabled={!props.canSkip}
          onMouseDown={stop}
          onClick={props.onSkip}
          data-testid="action-skip"
        >
          <kbd className="pare-key" aria-hidden>
            ↓
          </kbd>
          Later
        </button>
      )}
    </div>
  );
}

function Suggested({ reason }: { reason: string | undefined }) {
  const said = reason ? `The model suggests this: ${reason}` : "The model suggests this";
  return (
    <span
      className="pare-suggested"
      role="img"
      aria-label={said}
      title={said}
      data-testid="suggested"
    >
      <SparkleIcon />
    </span>
  );
}
