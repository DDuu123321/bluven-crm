import 'server-only';

const hits = new Map<string, number[]>();

/**
 * Sliding-window limiter held in memory. Good for a single web process, which is how this
 * application is deployed; it resets when the process restarts.
 */
export function allow(key: string, limit: number, windowMs: number, now: number = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) {
    for (const [k, v] of hits) if (v.every((t) => t <= now - windowMs)) hits.delete(k);
  }
  return true;
}

/** Seconds until the oldest hit in the window expires. */
export function retryAfter(key: string, windowMs: number, now: number = Date.now()): number {
  const oldest = (hits.get(key) ?? [])[0];
  return oldest ? Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)) : 1;
}
