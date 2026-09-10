import type { RefObject } from "react";

interface NoteFieldProps {
  value: string;
  onChange: (value: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

// Two lines under the slide, always there and always focused, so typing is
// commenting; it clears with the card. The box does not grow with the text:
// nothing in the deck may move while you are using it, and a note this long
// is a sign the item should be deferred instead.
export function NoteField({ value, onChange, inputRef }: NoteFieldProps) {
  return (
    <div className="pare-note">
      <textarea
        ref={inputRef}
        rows={2}
        value={value}
        placeholder="Add a note"
        aria-label="Note for this item"
        spellCheck
        // The session schema caps a note here; over it, the cached session
        // would fail its own parse on reload and take the progress with it.
        maxLength={2000}
        onChange={(e) => onChange(e.target.value)}
        data-testid="note"
      />
      {value.length > 0 && <p className="pare-note__caption">Goes with your decision</p>}
    </div>
  );
}
