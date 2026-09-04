// The actions around the slide. The two outcomes sit at the left and right of
// the card in their colors, and grow toward the card as it is dragged their
// way. Later, the extra actions, and the note trigger sit under the card as
// dim text with digits. The action Enter fires carries a return glyph.

import { motion, useTransform, type MotionValue } from "motion/react";
import { DISPOSE, KEEP, type SessionConfig } from "../../../schema";

const stop = (e: React.MouseEvent) => e.preventDefault();

interface SideActionProps {
  kind: "keep" | "dispose";
  config: SessionConfig;
  // Whether Enter fires this action for the current card.
  isEnter: boolean;
  // 0 at rest, 1 when the card has reached this side's commit distance.
  pull: MotionValue<number>;
  onAction: (actionId: string) => void;
}

export function SideAction({ kind, config, isEnter, pull, onAction }: SideActionProps) {
  const action = kind === "keep" ? config.keep : config.dispose;
  const id = kind === "keep" ? KEEP : DISPOSE;
  const rest = isEnter ? 1 : 0.55;
  const opacity = useTransform(pull, [0, 1], [rest, 1]);
  const scale = useTransform(pull, [0, 1], [1, 1.14]);
  const x = useTransform(pull, [0, 1], [0, kind === "keep" ? -10 : 10]);
  return (
    <div className={`pare-side pare-side--${kind}`}>
      <motion.button
        type="button"
        className={"pare-side__btn" + (isEnter ? " is-enter" : "")}
        style={{ opacity, scale, x }}
        title={action.hint}
        onMouseDown={stop}
        onClick={() => onAction(id)}
        data-testid={`action-${kind}`}
      >
        <span className="pare-side__arrow" aria-hidden>
          {kind === "keep" ? "→" : "←"}
        </span>
        <span className="pare-side__label">{action.label}</span>
        {isEnter && <EnterMark />}
      </motion.button>
    </div>
  );
}

interface ExtraActionsProps {
  config: SessionConfig;
  canSkip: boolean;
  // The id of the action Enter fires, so an extra action can carry the mark.
  enterAction: string;
  onAction: (actionId: string) => void;
  onSkip: () => void;
  // Rendered last: the note trigger, when notes are on and the note is closed.
  noteTrigger?: React.ReactNode;
}

export function ExtraActions(props: ExtraActionsProps) {
  const { config } = props;
  const hasAny = config.skip || config.extra_actions.length > 0 || props.noteTrigger;
  if (!hasAny) return null;
  return (
    <div className="pare-extras" role="group" aria-label="More actions">
      {config.skip && (
        <button
          type="button"
          className="pare-extra"
          title="Move to the bottom of the stack"
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
      {config.extra_actions.map((action, i) => {
        const isEnter = props.enterAction === action.id;
        return (
          <button
            key={action.id}
            type="button"
            className={"pare-extra" + (isEnter ? " is-enter" : "")}
            title={action.hint}
            onMouseDown={stop}
            onClick={() => props.onAction(action.id)}
            data-testid={`action-${action.id}`}
          >
            <span className="pare-extra__key" aria-hidden>
              {i + 1}
            </span>
            {action.label}
            {isEnter && <EnterMark />}
          </button>
        );
      })}
      {props.noteTrigger}
    </div>
  );
}

export function EnterMark() {
  return (
    <span className="pare-enter" aria-label="Enter">
      ↵
    </span>
  );
}
