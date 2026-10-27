import { useLayoutEffect, type RefObject } from "react";

interface NoteFieldProps {
  value: string;
  onChange: (value: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

// A field under the outcomes, always there and always focused, so typing is
// commenting; it clears with the card. It grows with the text up to the
// stylesheet's max-height and then scrolls. It is the last thing in the deck,
// so inline it moves only the status row under it; in full screen, where the
// deck is centred, the deck rises by half of what it grows.
export function NoteField({ value, onChange, inputRef }: NoteFieldProps) {
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    // Collapse first so a shorter note can shrink the box, then fit the text.
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value, inputRef]);

  return (
    <div className="pare-note">
      <textarea
        ref={inputRef}
        rows={1}
        value={value}
        placeholder="Add a note to this decision"
        aria-label="Note for this item"
        spellCheck
        // The session schema caps a note here; over it, the cached session
        // would fail its own parse on reload and take the progress with it.
        maxLength={2000}
        onChange={(e) => onChange(e.target.value)}
        data-testid="note"
      />
    </div>
  );
}
