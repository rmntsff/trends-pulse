/** Мінімальний кеш "ключ → JSON" з часом життя. */
export interface JsonCache {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

/** Кеш у пам'яті процесу. Живе, поки живе екземпляр Worker (зазвичай хвилини–години). */
export class MemoryCache implements JsonCache {
  private readonly entries = new Map<string, { json: string; expiresAt: number }>();

  constructor(
    private readonly maxEntries = 500,
    private readonly now: () => number = Date.now,
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return JSON.parse(entry.json) as T;
  }

  async put(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.entries.delete(key);
    this.entries.set(key, { json: JSON.stringify(value), expiresAt: this.now() + ttlSeconds * 1000 });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
  }
}

/**
 * Пам'ять + Cache API Cloudflare (спільний для екземплярів у одному дата-центрі).
 * На адресах *.workers.dev Cache API може нічого не зберігати — тоді працює лише пам'ять,
 * і це нормально: кеш тут для швидкості та економії запитів, а не для коректності.
 */
export class EdgeCache implements JsonCache {
  constructor(private readonly memory: JsonCache = new MemoryCache()) {}

  private static url(key: string): string {
    return `https://cache.trends-pulse.internal/${encodeURIComponent(key)}`;
  }

  async get<T>(key: string): Promise<T | null> {
    const local = await this.memory.get<T>(key);
    if (local !== null) return local;
    try {
      const hit = await (caches as unknown as { default: Cache }).default.match(EdgeCache.url(key));
      return hit ? ((await hit.json()) as T) : null;
    } catch {
      return null;
    }
  }

  async put(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.memory.put(key, value, ttlSeconds);
    try {
      await (caches as unknown as { default: Cache }).default.put(
        EdgeCache.url(key),
        new Response(JSON.stringify(value), {
          headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttlSeconds}` },
        }),
      );
    } catch {
      // Cache API недоступний — лишається кеш у пам'яті.
    }
  }
}
