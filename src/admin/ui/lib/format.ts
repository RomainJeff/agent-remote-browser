export const ago = (ts: string | null | undefined) => {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
export const day = (ts: string | number | Date) => new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const leftMin = (ts: string) => Math.max(0, Math.ceil((Date.parse(ts) - Date.now()) / 60000));
/** Domains typed as a list: commas or spaces. */
export const domains = (s: string) => s.split(/[\s,]+/).filter(Boolean);
export const message = (e: unknown) => e instanceof Error ? e.message : String(e);
