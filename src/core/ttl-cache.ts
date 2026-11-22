/**
 * A read-through TTL cache with single-flight loading.
 *
 * Written for one job: the console's read endpoints proxy GitLab and Jira, and a
 * page that three people have open costs three times the forge calls for the same
 * answer. What makes that worth caching is not latency — it is somebody's rate
 * limit, which is shared, finite, and spent by whoever asks first.
 *
 * The single-flight half matters at least as much as the TTL. Three tabs polling
 * the same graph every three seconds is three concurrent Jira searches racing each
 * other, and a TTL alone does not help: none of them has finished writing an entry
 * yet when the next one starts. So the promise itself is what gets cached, and
 * concurrent callers for one key await the same load.
 *
 * Deliberately not a general-purpose cache:
 *
 * - **Rejections are never cached.** A forge call that failed has to be
 *   immediately retryable — caching a timeout would turn a blip into a minute of
 *   guaranteed failure. Serve-stale-on-error is genuinely valuable when gitlab.com
 *   is down, but it changes what an error *means* to the caller, so it is not
 *   here.
 * - **`now` is injectable** so tests advance a clock instead of sleeping, matching
 *   `retry.ts` and `watermark.ts`.
 * - **Bounded, evicting oldest-first.** Keys here are per user and per merge
 *   request, so an unbounded map is a slow leak in a process that runs for weeks.
 * - **No `get`/`set`.** Every read goes through `fetch`, which is what makes the
 *   single-flight guarantee hold rather than being something each call site has to
 *   remember to arrange.
 */

interface Entry<T> {
  /** The in-flight or settled load. Cached as a promise — that is the single flight. */
  value: Promise<T>;
  /**
   * When a settled value stops being served. Pending values remain coalesced
   * regardless of this timestamp: allowing a slow provider call to expire while
   * it is still running defeats the single-flight guarantee.
   */
  expiresAt: number;
  /**
   * Whether the load is still out. Only used to tell the two kinds of hit apart in
   * `stats` — a hit on a settled value saved a forge call, a hit on a pending one
   * saved a *concurrent* forge call, and the second number is the one that says
   * whether the single flight is earning its keep.
   */
  pending: boolean;
  bytes: number;
  /** At most one fresh load queued behind this pending load. */
  refresh?: Promise<unknown>;
}

export interface TtlCacheStats {
  hits: number;
  misses: number;
  /** Hits that joined a load already in flight rather than a settled value. */
  coalesced: number;
  evictions: number;
  /** Entries currently held, in flight ones included. */
  size: number;
  pending: number;
  bytes: number;
  rejected: number;
}

export class TtlCache {
  #entries = new Map<string, Entry<unknown>>();
  #now: () => number;
  #max: number;
  #maxPending: number;
  #maxBytes: number;
  #sizeOf: (value: unknown) => number;
  #bytes = 0;
  #hits = 0;
  #misses = 0;
  #coalesced = 0;
  #evictions = 0;
  #rejected = 0;

  constructor(options: {
    max?: number;
    maxPending?: number;
    maxBytes?: number;
    sizeOf?: (value: unknown) => number;
    now?: () => number;
  } = {}) {
    this.#max = options.max ?? 500;
    this.#maxPending = options.maxPending ?? Math.min(50, this.#max);
    this.#maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    this.#sizeOf = options.sizeOf ?? estimateBytes;
    this.#now = options.now ?? Date.now;
  }

  /**
   * The cached value for `key`, loading it if there isn't a live one.
   *
   * `ttlMs` is a property of the *call* rather than of the cache, because one cache
   * holds entries with wildly different lifetimes: a merge request's diff is
   * immutable for ten minutes, its list of open MRs is stale in one.
   */
  fetch<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const existing = this.#entries.get(key);
    if (existing && (existing.pending || existing.expiresAt > this.#now())) {
      this.#hits += 1;
      if (existing.pending) this.#coalesced += 1;
      return existing.value as Promise<T>;
    }
    if (existing) this.#drop(key, existing);

    if (this.#pendingCount() >= this.#maxPending) {
      this.#rejected += 1;
      return Promise.reject(new Error("response cache has reached its pending-load capacity"));
    }

    this.#misses += 1;
    // Started before the entry is stored, so a `load` that throws synchronously
    // never leaves a rejected promise in the map.
    const value = load();
    const entry: Entry<unknown> = {
      value,
      expiresAt: this.#now() + ttlMs,
      pending: true,
      bytes: 0,
    };
    this.#entries.set(key, entry);
    this.#evict();

    // A failure must not be what the next caller gets. Removed only if this
    // entry is still the current one: a later `fetch` may already have replaced
    // it, and dropping that one would throw away a good value.
    value.then(
      (settled) => {
        entry.pending = false;
        // Freshness starts when a value exists to serve. A slow request must not
        // immediately be stale simply because its load took longer than its TTL.
        entry.expiresAt = this.#now() + ttlMs;
        if (this.#entries.get(key) === entry) {
          entry.bytes = this.#sizeOf(settled);
          this.#bytes += entry.bytes;
          this.#evict();
        }
      },
      () => {
        entry.pending = false;
        if (this.#entries.get(key) === entry) this.#drop(key, entry);
      },
    );

    return value;
  }

  /**
   * Forces a fresh value without allowing repeated refresh clicks to duplicate
   * a load already in flight. If the current load is pending, exactly one
   * follow-up is queued and every refresher joins it.
   */
  refresh<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const existing = this.#entries.get(key);
    if (!existing?.pending) {
      if (existing) this.#drop(key, existing);
      return this.fetch(key, ttlMs, load);
    }
    if (existing.refresh) return existing.refresh as Promise<T>;
    const refresh = existing.value
      .catch(() => undefined)
      .then(() => {
        if (this.#entries.get(key) === existing) this.#drop(key, existing);
        return this.fetch(key, ttlMs, load);
      });
    existing.refresh = refresh;
    return refresh;
  }

  /**
   * Whether `key` has a live entry — for tests and diagnostics, not for call
   * sites. Checking before fetching is the race the single flight exists to close.
   */
  has(key: string): boolean {
    const entry = this.#entries.get(key);
    return entry !== undefined && (entry.pending || entry.expiresAt > this.#now());
  }

  /** Drops one key, live or not. Returns whether there was anything to drop. */
  delete(key: string): boolean {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    this.#drop(key, entry);
    return true;
  }

  /**
   * Drops every key starting with `prefix`, and returns how many.
   *
   * The resource-level hook, and the reason composed keys put the resource first:
   * a merge request event has to reach every user's copy of the listing, and
   * scoping the key by user first would make that a full scan.
   */
  invalidate(prefix: string): number {
    let dropped = 0;
    for (const key of this.#entries.keys()) {
      if (key.startsWith(prefix)) {
        this.#drop(key, this.#entries.get(key)!);
        dropped += 1;
      }
    }
    return dropped;
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  get stats(): TtlCacheStats {
    return {
      hits: this.#hits,
      misses: this.#misses,
      coalesced: this.#coalesced,
      evictions: this.#evictions,
      size: this.#entries.size,
      pending: this.#pendingCount(),
      bytes: this.#bytes,
      rejected: this.#rejected,
    };
  }

  /**
   * Keeps the map bounded: expired entries first, then the oldest insertions.
   *
   * Insertion order rather than least-recently-used, which `Map` gives for free
   * and which is close enough here — entries live for seconds to minutes, so
   * "oldest" and "least useful" mostly coincide, and a real LRU would mean
   * re-keying the map on every hit for a cache whose whole point is to be cheap.
   */
  #evict(): void {
    if (this.#entries.size <= this.#max && this.#bytes <= this.#maxBytes) return;

    const now = this.#now();
    for (const [key, entry] of this.#entries) {
      if (this.#entries.size <= this.#max && this.#bytes <= this.#maxBytes) return;
      if (!entry.pending && entry.expiresAt <= now) {
        this.#drop(key, entry);
        this.#evictions += 1;
      }
    }

    for (const [key, entry] of this.#entries) {
      if (this.#entries.size <= this.#max && this.#bytes <= this.#maxBytes) return;
      // Never evict an in-flight load: doing so permits another caller to start
      // the same work while the first request still consumes provider capacity.
      if (entry.pending) continue;
      this.#drop(key, entry);
      this.#evictions += 1;
    }
  }

  #pendingCount(): number {
    let count = 0;
    for (const entry of this.#entries.values()) if (entry.pending) count += 1;
    return count;
  }

  #drop(key: string, entry: Entry<unknown>): void {
    if (this.#entries.get(key) !== entry) return;
    this.#entries.delete(key);
    this.#bytes = Math.max(0, this.#bytes - entry.bytes);
  }
}

function estimateBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "");
  } catch {
    return 0;
  }
}
