import { useLayoutEffect, type RefObject } from "react";

interface NoteFieldProps {
  value: string;
  onChange: (value: string) => void;
  // What Enter will do, shown at the right edge of the field.
  enterLabel: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

export function NoteField({ value, onChange, enterLabel, inputRef }: NoteFieldProps) {
  // Grow with the text. Re-measure on width changes too: the host sizes the
  // iframe after first paint, and a measurement taken at the wrong width
  // wraps the placeholder into several lines.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const measure = () => {
      el.style.height = "0px";
      el.style.height = `${Math.min(120, el.scrollHeight)}px`;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el.parentElement ?? el);
    return () => observer.disconnect();
  }, [value, inputRef]);

  return (
    <div className="pare-note">
      <textarea
        ref={inputRef}
        rows={1}
        value={value}
        placeholder="Add a note, or just decide…"
        aria-label="Note for this item"
        spellCheck
        onChange={(e) => onChange(e.target.value)}
        data-testid="note"
      />
      <span className="pare-note__hint" aria-hidden>
        <kbd className="pare-kbd">↵</kbd> {enterLabel}
      </span>
    </div>
  );
}
