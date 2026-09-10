// Hand-drawn 16px line icons, kept inline so the single-file build has no
// asset requests.

const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function ExpandIcon({ active = false }: { active?: boolean }) {
  return active ? (
    <svg {...base}>
      <path d="M6 2v4H2M10 14v-4h4M2 10h4v4M14 6h-4V2" />
    </svg>
  ) : (
    <svg {...base}>
      <path d="M9 2h5v5M7 14H2V9M14 2l-5 5M2 14l5-5" />
    </svg>
  );
}

export function MoreIcon() {
  return (
    <svg {...base}>
      <circle cx="3" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="13" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function UndoIcon() {
  return (
    <svg {...base}>
      <path d="M6 4L2.5 7.5 6 11" />
      <path d="M3 7.5h6.5a3.5 3.5 0 0 1 0 7H8" />
    </svg>
  );
}

// The two outcomes, drawn to fill their disc.
export function HeartIcon() {
  return (
    <svg width={26} height={26} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 20.7C6.1 16.5 3 13.3 3 9.7 3 7 5.1 5 7.7 5c1.7 0 3.3.9 4.3 2.3C13 5.9 14.6 5 16.3 5 18.9 5 21 7 21 9.7c0 3.6-3.1 6.8-9 11z" />
    </svg>
  );
}

export function CrossIcon() {
  return (
    <svg
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.6}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </svg>
  );
}

// The model's suggestion. Blue, and used for nothing else.
export function SparkleIcon() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      <path d="M8 1.2l1.35 3.95a2 2 0 0 0 1.25 1.25L14.8 7.8l-4.2 1.4a2 2 0 0 0-1.25 1.25L8 14.4l-1.35-3.95a2 2 0 0 0-1.25-1.25L1.2 7.8l4.2-1.4a2 2 0 0 0 1.25-1.25z" />
      <path d="M13.1 1.1l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z" opacity="0.7" />
    </svg>
  );
}
