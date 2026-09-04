import { useLayoutEffect, type RefObject } from "react";

interface NoteFieldProps {
  value: string;
  onChange: (value: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

// A single line under the slide that grows with the text. It appears on the
// first typed letter and closes with the card.
export function NoteField({ value, onChange, inputRef }: NoteFieldProps) {
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
        placeholder="Note"
        aria-label="Note for this item"
        spellCheck
        onChange={(e) => onChange(e.target.value)}
        data-testid="note"
      />
    </div>
  );
}
