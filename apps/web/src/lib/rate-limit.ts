import 'server-only';

const hits = new Map<string, number[]>();
const MAX_KEYS = 50_000;
/** No limit in this application looks further back than this; older hits can be forgotten whatever their key. */
const LONGEST_WINDOW_MS = 15 * 60_000;
let lastSweep = 0;

/** Housekeeping whose cost does not grow with traffic: a sweep at most once a minute, eviction in batches. */
function tidy(now: number): void {
  if (now - lastSweep >= 60_000) {
    lastSweep = now;
    for (const [key, times] of hits) if (times.every((t) => t <= now - LONGEST_WINDOW_MS)) hits.delete(key);
  }
  if (hits.size > MAX_KEYS) {
    let drop = MAX_KEYS / 10;
    for (const key of hits.keys()) {
      if (drop-- <= 0) break;
      hits.delete(key);
    }
  }
}

/**
 * Sliding-window limiter held in memory. Good for a single web process, which is how this
 * application is deployed; it resets when the process restarts.
 */
export function allow(key: string, limit: number, windowMs: number, now: number = Date.now()): boolean {
  if (windowMs > LONGEST_WINDOW_MS) throw new Error('rate-limit window is longer than the housekeeping horizon');
  const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.delete(key);
  hits.set(key, recent);
  tidy(now);
  return true;
}

/** Seconds until the oldest hit in the window expires. */
export function retryAfter(key: string, windowMs: number, now: number = Date.now()): number {
  const oldest = (hits.get(key) ?? [])[0];
  return oldest ? Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)) : 1;
}
