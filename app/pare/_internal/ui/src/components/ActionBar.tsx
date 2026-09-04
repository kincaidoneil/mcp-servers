import { DISPOSE, KEEP, type SessionConfig } from "../../../schema";

interface ActionBarProps {
  config: SessionConfig;
  canSkip: boolean;
  onAction: (actionId: string) => void;
  onSkip: () => void;
}

const stop = (e: React.MouseEvent) => e.preventDefault();

export function ActionBar({ config, canSkip, onAction, onSkip }: ActionBarProps) {
  return (
    <div className="pare-actions" role="group" aria-label="Decide">
      <button
        type="button"
        className="pare-btn pare-btn--dispose"
        title={config.dispose.hint}
        onMouseDown={stop}
        onClick={() => onAction(DISPOSE)}
        data-testid="action-dispose"
      >
        <kbd className="pare-kbd">←</kbd>
        {config.dispose.label}
      </button>
      {config.skip && (
        <button
          type="button"
          className="pare-btn pare-btn--quiet"
          title="Move to the bottom of the stack"
          disabled={!canSkip}
          onMouseDown={stop}
          onClick={onSkip}
          data-testid="action-skip"
        >
          Later
          <kbd className="pare-kbd">↓</kbd>
        </button>
      )}
      <button
        type="button"
        className="pare-btn pare-btn--keep"
        title={config.keep.hint}
        onMouseDown={stop}
        onClick={() => onAction(KEEP)}
        data-testid="action-keep"
      >
        {config.keep.label}
        <kbd className="pare-kbd">→</kbd>
      </button>
      {config.extra_actions.length > 0 && (
        <div className="pare-actions__extra">
          {config.extra_actions.map((action, i) => (
            <button
              key={action.id}
              type="button"
              className="pare-btn pare-btn--quiet"
              title={action.hint}
              onMouseDown={stop}
              onClick={() => onAction(action.id)}
              data-testid={`action-${action.id}`}
            >
              {action.label}
              <kbd className="pare-kbd">{i + 1}</kbd>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Legend({ notes }: { notes: boolean }) {
  return (
    <div className="pare-legend" aria-hidden>
      <span>
        <kbd className="pare-kbd">⌘Z</kbd> undo
      </span>
      <span>
        <kbd className="pare-kbd">↑</kbd> expand
      </span>
      {notes && <span>type to add a note</span>}
      <span>drag or swipe the card</span>
    </div>
  );
}
