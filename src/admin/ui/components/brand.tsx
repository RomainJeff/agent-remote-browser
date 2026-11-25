/** The mark: a browser window whose tab says who drives (teal: an agent), over a second one, with a pointer. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="flex-none">
      <rect x="9.5" y="3.5" width="20" height="16" rx="2.5" fill="none" stroke="var(--ink-3)" strokeWidth="2" />
      <path d="M2.5 12.5H20a2.5 2.5 0 0 1 2.5 2.5v11.5a2.5 2.5 0 0 1-2.5 2.5H5a2.5 2.5 0 0 1-2.5-2.5Z" fill="var(--surface)" stroke="var(--ink)" strokeWidth="2.25" strokeLinejoin="round" />
      <path d="M1.375 13.5v-3a2 2 0 0 1 2-2H10a2 2 0 0 1 2 2v3Z" fill="var(--agent)" />
      <path d="M8.5 16.5v9.1l2.4-2.3 1.7 3.7 1.7-.8-1.7-3.6 3.3-.2Z" fill="var(--ink)" />
    </svg>
  );
}

/** Mark and name: in a row in the sidebar, stacked and larger above the sign-in forms. */
export function Brand({ large }: { large?: boolean }) {
  return large ? (
    <div className="flex flex-col items-center gap-3.5"><Mark size={44} /><b className="text-[17px] font-semibold tracking-[-0.01em]">Agent Remote Browser</b></div>
  ) : (
    <div className="flex items-center gap-2.5 px-2"><Mark /><b className="text-sm font-semibold tracking-[-0.01em]">Agent Remote Browser</b></div>
  );
}
