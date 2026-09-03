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

export function ChevronIcon({ up = false }: { up?: boolean }) {
  return (
    <svg {...base} width={12} height={12}>
      {up ? <path d="M3 10l5-5 5 5" /> : <path d="M3 6l5 5 5-5" />}
    </svg>
  );
}

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
