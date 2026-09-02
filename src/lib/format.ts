/** Lightweight date + reading-time helpers (no dependencies). */

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export function formatDateLong(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

export function formatYear(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', { year: 'numeric' }).format(date);
}

/** Rough reading time from raw markdown source, in minutes. */
export function readTimeInMinutes(rawBody: string): number {
  const words = rawBody
    .replace(/```[\s\S]*?```/g, ' ') // drop code blocks
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / 230));
}
