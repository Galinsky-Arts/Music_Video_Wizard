/** "m:ss.mmm" (or "m:ss", or plain seconds) to integer milliseconds; null for blank, NaN for invalid. */
export function parseTimecode(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const match = /^(?:(\d+):)?(\d{1,2}|\d+)(?:\.(\d{1,3}))?$/.exec(text);
  if (!match) return Number.NaN;
  const minutes = match[1] ? Number(match[1]) : 0;
  const seconds = Number(match[2]);
  if (match[1] && seconds >= 60) return Number.NaN;
  const millis = match[3] ? Number(match[3].padEnd(3, "0")) : 0;
  return (minutes * 60 + seconds) * 1000 + millis;
}

export function formatTimecode(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}
