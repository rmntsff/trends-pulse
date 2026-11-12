import { describe, expect, it } from "vitest";
import { parseTrendsRss } from "../src/rss";
import { TrendsLoadError } from "../src/types";

const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:atom="http://www.w3.org/2005/Atom" xmlns:ht="https://trends.google.com/trending/rss" version="2.0">
  <channel>
    <title>Daily Search Trends</title>
    <item>
      <title>Збірна України</title>
      <ht:approx_traffic>100K+</ht:approx_traffic>
      <description></description>
      <link>https://trends.google.com/trending/rss?geo=UA</link>
      <pubDate>Mon, 19 Oct 2026 14:00:00 -0700</pubDate>
      <ht:picture>https://example.com/pic.jpg</ht:picture>
      <ht:news_item>
        <ht:news_item_title>Україна здобула перемогу у &amp;quot;вирішальному&amp;quot; матчі</ht:news_item_title>
        <ht:news_item_url>https://example.com/news/123</ht:news_item_url>
        <ht:news_item_source>Суспільне Спорт</ht:news_item_source>
      </ht:news_item>
      <ht:news_item>
        <ht:news_item_title>Друга новина</ht:news_item_title>
        <ht:news_item_snippet>Фрагмент &lt;b&gt;тексту&lt;/b&gt;</ht:news_item_snippet>
        <ht:news_item_url>javascript:alert(1)</ht:news_item_url>
        <ht:news_item_source>ЗМІ</ht:news_item_source>
      </ht:news_item>
    </item>
    <item><title>2026</title></item>
    <item><title>   </title></item>
  </channel>
</rss>`;

describe("parseTrendsRss", () => {
  it("parses items and news", () => {
    const trends = parseTrendsRss(feed, "UA");
    expect(trends).toHaveLength(2);
    const first = trends[0]!;
    expect(first).toMatchObject({
      rank: 1,
      key: "UA:збірна україни",
      title: "Збірна України",
      approxTraffic: "100K+",
      imageUrl: "https://example.com/pic.jpg",
      publishedAtMillis: 1_792_443_600_000,
      openUrl: "https://example.com/news/123",
    });
    expect(first.news[0]).toMatchObject({ title: 'Україна здобула перемогу у "вирішальному" матчі', source: "Суспільне Спорт" });
  });

  it("rejects unsafe urls and strips html", () => {
    const second = parseTrendsRss(feed, "UA")[0]!.news[1]!;
    expect(second.url).toBeNull();
    expect(second.snippet).toBe("Фрагмент тексту");
  });

  it("keeps numeric titles as text and falls back to search", () => {
    const trend = parseTrendsRss(feed, "UA")[1]!;
    expect(trend.title).toBe("2026");
    expect(trend.approxTraffic).toBeNull();
    expect(trend.openUrl).toBe("https://www.google.com/search?q=2026");
  });

  it("treats a single item / single news item as lists", () => {
    const one = `<rss><channel><item><title>a</title><news_item><news_item_title>n</news_item_title></news_item></item></channel></rss>`;
    expect(parseTrendsRss(one, "US")[0]!.news).toHaveLength(1);
  });

  it("returns empty list for an empty channel", () => {
    expect(parseTrendsRss("<rss><channel><title>x</title></channel></rss>", "US")).toEqual([]);
  });

  it.each(["<rss><channel><item><title>oops</channel>", "<html><body>Too many requests</body></html>", "not xml"])(
    "throws parse error for %s",
    (body) => {
      expect(() => parseTrendsRss(body, "UA")).toThrowError(TrendsLoadError);
    },
  );
});
