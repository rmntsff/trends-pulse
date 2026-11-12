import { XMLParser, XMLValidator } from "fast-xml-parser";
import { TrendsLoadError, type NewsArticle, type Region, type Trend } from "./types";

const MAX_NEWS_PER_TREND = 3;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const FEED_URL = "https://trends.google.com/trending/rss";

const xml = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true, // ht:approx_traffic -> approx_traffic
  parseTagValue: false, // усе лишається рядками ("200+" не стає числом)
  trimValues: true,
  isArray: (name) => name === "item" || name === "news_item",
});

/** Прибирає HTML-теги та зайві пробіли; сутності вже розкодував XML-парсер. */
export function cleanText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Лише абсолютні http/https-посилання з хостом. Відсікає `javascript:`, `intent:` тощо. */
export function safeWebUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const url = new URL(raw.trim());
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseDate(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const millis = Date.parse(raw);
  return Number.isNaN(millis) ? null : millis;
}

/**
 * Парсить https://trends.google.com/trending/rss?geo=XX.
 * Некоректний XML або не-RSS — це помилка, а не порожній список.
 */
export function parseTrendsRss(body: string, region: Region): Trend[] {
  if (XMLValidator.validate(body) !== true) throw new TrendsLoadError("parse", "Некоректний XML");
  const channel = xml.parse(body)?.rss?.channel;
  if (channel === undefined || channel === null) throw new TrendsLoadError("parse", "Відповідь не схожа на RSS");

  const trends: Trend[] = [];
  for (const item of (channel.item ?? []) as Record<string, unknown>[]) {
    const title = cleanText(item.title);
    if (!title) continue;

    const news: NewsArticle[] = [];
    for (const raw of (item.news_item ?? []) as Record<string, unknown>[]) {
      const article: NewsArticle = {
        title: cleanText(raw.news_item_title),
        url: safeWebUrl(raw.news_item_url),
        source: cleanText(raw.news_item_source),
        snippet: cleanText(raw.news_item_snippet),
      };
      if ((article.title || article.snippet) && news.length < MAX_NEWS_PER_TREND) news.push(article);
    }

    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(title)}`;
    const traffic = typeof item.approx_traffic === "string" ? item.approx_traffic.trim() : "";
    trends.push({
      key: `${region}:${title.toLowerCase()}`,
      region,
      rank: trends.length + 1,
      title,
      approxTraffic: traffic || null,
      publishedAtMillis: parseDate(item.pubDate),
      imageUrl: safeWebUrl(item.picture),
      news,
      openUrl: news[0]?.url ?? searchUrl,
      searchUrl,
    });
  }
  return trends;
}

/** Завантажує RSS Google Trends. Джерело неофіційне: формат може змінитися. */
export async function fetchTrends(region: Region, fetcher: typeof fetch = fetch): Promise<Trend[]> {
  let response: Response;
  try {
    response = await fetcher(`${FEED_URL}?geo=${region}`, {
      headers: { Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.1" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new TrendsLoadError("network", e instanceof Error ? e.message : "Network error");
  }
  if (!response.ok) throw new TrendsLoadError("http", `HTTP ${response.status}`);

  const body = await response.text();
  if (body.length > MAX_BODY_BYTES) throw new TrendsLoadError("parse", "Завелика відповідь");
  return parseTrendsRss(body, region);
}
