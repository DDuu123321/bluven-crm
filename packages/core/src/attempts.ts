/**
 * Counts recent failures per key, in memory. It slows guessing down; it is not the record of
 * anything. The counts are per process and are lost on a restart, which matches how the web
 * application runs (one process) and is why the lasting lock on an account lives in the database.
 */
export class FailureLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    /** Failures allowed inside the window before further attempts are refused. */
    private readonly limit: number,
    private readonly windowMs: number,
    /** Upper bound on tracked keys, so a flood of made-up keys cannot use up memory. */
    private readonly maxKeys = 50_000,
  ) {}

  private recent(key: string, now: number): number[] {
    return (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
  }

  /** Seconds until this key may try again. Zero when it may try now. */
  blockedFor(key: string, now: number): number {
    const recent = this.recent(key, now);
    if (recent.length < this.limit) return 0;
    return Math.max(1, Math.ceil((recent[recent.length - this.limit]! + this.windowMs - now) / 1000));
  }

  record(key: string, now: number): void {
    const recent = this.recent(key, now);
    recent.push(now);
    this.hits.delete(key); // re-insert, so the map stays ordered by last use
    this.hits.set(key, recent.slice(-this.limit));
    this.tidy(now);
  }

  clear(key: string): void {
    this.hits.delete(key);
  }

  reset(): void {
    this.hits.clear();
    this.lastSweep = 0;
  }

  get size(): number {
    return this.hits.size;
  }

  /** Housekeeping whose cost does not grow with the number of calls: a sweep at most once a minute, and eviction in batches. */
  private tidy(now: number): void {
    if (now - this.lastSweep >= 60_000) {
      this.lastSweep = now;
      for (const [key, times] of this.hits) if (times.every((t) => t <= now - this.windowMs)) this.hits.delete(key);
    }
    if (this.hits.size > this.maxKeys) {
      let drop = Math.ceil(this.maxKeys / 10);
      for (const key of this.hits.keys()) {
        if (drop-- <= 0) break;
        this.hits.delete(key);
      }
    }
  }
}

/**
 * The network a client address belongs to, for limits "per address". An IPv6 customer holds a
 * whole /64, so limiting single IPv6 addresses limits nothing; IPv4 is used as it is.
 */
export function networkKey(ip: string | null | undefined): string | null {
  const v = (ip ?? '').trim().toLowerCase();
  if (!v) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (mapped) return mapped[1]!;
  if (!v.includes(':')) return v;
  const [head = '', tail] = v.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}
