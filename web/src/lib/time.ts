/**
 * Durations are computed against the snapshot's own `asOf`, not the
 * browser clock — the page shows what the sidecar knew when it looked,
 * and a VPS/browser clock skew can never invent negative ages.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** `90s` → "1m", `7500s` → "2h 5m", 3 days → "3d 2h". */
export function formatDuration(ms: number): string {
  if (ms < MINUTE_MS) return '<1m';
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m`;
  if (ms < DAY_MS) {
    const hours = Math.floor(ms / HOUR_MS);
    const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

export function ago(iso: string, asOf: string): string {
  return `${formatDuration(Math.max(0, Date.parse(asOf) - Date.parse(iso)))} ago`;
}

export function durationSince(iso: string, asOf: string): string {
  return formatDuration(Math.max(0, Date.parse(asOf) - Date.parse(iso)));
}

/** Local wall-clock time of an ISO stamp — the "as of" display. */
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}
