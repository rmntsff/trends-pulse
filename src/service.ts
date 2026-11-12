import type { JsonCache } from "./cache";
import { explain, GeminiError, type GeminiConfig, type PromptItem } from "./gemini";
import { fetchTrends } from "./rss";
import type { Explanation, Language, Region, Trend } from "./types";

const TRENDS_TTL_SECONDS = 5 * 60;
const EXPLANATION_TTL_SECONDS = 6 * 60 * 60;
const DEFAULT_RATE_LIMIT_COOLDOWN_MILLIS = 30_000;

export interface TrendsSnapshot {
  trends: Trend[];
  fetchedAtMillis: number;
}

/** Невеликий стабільний хеш (FNV-1a), щоб ключ кешу залежав від заголовка новини. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export class TrendsService {
  private rateLimitedUntil = 0;

  constructor(
    private readonly cache: JsonCache,
    /** null — ключ Gemini не налаштовано. */
    private readonly gemini: GeminiConfig | null,
    private readonly loadTrends: (region: Region) => Promise<Trend[]> = fetchTrends,
    private readonly now: () => number = Date.now,
  ) {}

  get aiEnabled(): boolean {
    return this.gemini !== null;
  }

  /** Тренди країни; RSS запитується не частіше ніж раз на 5 хвилин (крім примусового оновлення). */
  async getTrends(region: Region, forceRefresh = false): Promise<TrendsSnapshot> {
    const key = `trends:${region}`;
    if (!forceRefresh) {
      const cached = await this.cache.get<TrendsSnapshot>(key);
      if (cached) return cached;
    }
    const snapshot: TrendsSnapshot = { trends: await this.loadTrends(region), fetchedAtMillis: this.now() };
    await this.cache.put(key, snapshot, TRENDS_TTL_SECONDS);
    return snapshot;
  }

  private explanationKey(trend: Trend, language: Language): string {
    // Змінився заголовок новини — змінився контекст — буде нове пояснення.
    return `explain:${language}:${trend.key}:${hash(trend.news[0]?.title ?? "")}`;
  }

  /**
   * Пояснення для трендів. Клієнт надсилає лише країну й ключі: тексти для Gemini
   * беруться із серверної копії RSS, тож ендпоінт не можна використати як довільний проксі до Gemini.
   * У кеш потрапляють лише успішні відповіді.
   */
  async explainTrends(trends: Trend[], language: Language, forceRefresh = false): Promise<Record<string, Explanation>> {
    const result: Record<string, Explanation> = {};
    if (!this.gemini || trends.length === 0) return result;

    const pending: Trend[] = [];
    for (const trend of trends) {
      const cached = forceRefresh ? null : await this.cache.get<Explanation>(this.explanationKey(trend, language));
      if (cached) result[trend.key] = cached;
      else pending.push(trend);
    }
    if (pending.length === 0) return result;

    if (this.now() < this.rateLimitedUntil) {
      for (const trend of pending) {
        result[trend.key] = { status: "failed", reason: "rate_limited", detail: "Пауза після HTTP 429" };
      }
      return result;
    }

    // Короткі id ("t0", "t1"…) замість назв: модель не "виправить" їх у відповіді.
    const items: PromptItem[] = pending.map((trend, i) => ({
      id: `t${i}`,
      query: trend.title,
      traffic: trend.approxTraffic,
      headlines: trend.news.map((n) => n.title).filter(Boolean),
    }));

    try {
      const { texts, model } = await explain(items, language, this.gemini);
      for (const [i, trend] of pending.entries()) {
        const text = texts.get(`t${i}`);
        if (text) {
          const explanation: Explanation = { status: "ai", text, model };
          result[trend.key] = explanation;
          await this.cache.put(this.explanationKey(trend, language), explanation, EXPLANATION_TTL_SECONDS);
        } else {
          result[trend.key] = { status: "failed", reason: "bad_response", detail: "Gemini не повернув пояснення для цього тренду" };
        }
      }
    } catch (e) {
      if (!(e instanceof GeminiError)) throw e;
      if (e.reason === "rate_limited") {
        this.rateLimitedUntil = this.now() + (e.retryAfterMillis ?? DEFAULT_RATE_LIMIT_COOLDOWN_MILLIS);
      }
      for (const trend of pending) result[trend.key] = { status: "failed", reason: e.reason, detail: e.message };
    }
    return result;
  }
}
