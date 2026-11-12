import { describe, expect, it } from "vitest";
import { MemoryCache } from "../src/cache";
import { buildRequestBody, classifyHttpError, explain, ModelHealth, parseResponse, sanitizeModel, type GeminiConfig } from "../src/gemini";
import { TrendsService } from "../src/service";
import { handleApi } from "../src/worker";
import type { Env, Region, Trend } from "../src/types";

const trend = (region: Region, rank: number): Trend => ({
  key: `${region}:trend ${rank}`, region, rank, title: `Trend ${rank}`, approxTraffic: "200+", publishedAtMillis: null,
  imageUrl: null, news: [{ title: `Headline ${rank}`, url: "https://example.com", source: "ЗМІ", snippet: "" }],
  openUrl: "https://example.com", searchUrl: "https://www.google.com/search?q=x",
});
const trends = (region: Region, n = 12) => Array.from({ length: n }, (_, i) => trend(region, i + 1));

const ok = (...items: [string, string][]) =>
  new Response(JSON.stringify({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(items.map(([id, explanation]) => ({ id, explanation }))) }] } }],
  }));
const overloaded = () =>
  new Response(JSON.stringify({ error: { code: 503, status: "UNAVAILABLE", message: "This model is currently experiencing high demand." } }), { status: 503 });

/** Фейковий Gemini: віддає відповіді з черги та записує запити. */
function fakeGemini(responses: (() => Response)[]) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next();
  }) as unknown as typeof fetch;
  const config: GeminiConfig = { apiKey: "test-key", model: "gemini-3.8-flash", fallbackModels: ["gemini-3.6-flash"], fetcher, retryDelayMillis: 0, health: new ModelHealth() };
  return { calls, config };
}
const item = { id: "t0", query: "q", traffic: null, headlines: ["h"] };

describe("gemini client", () => {
  it("sends the key in a header, low thinking level and JSON schema", async () => {
    const { calls, config } = fakeGemini([() => ok(["t0", "Текст"])]);
    const result = await explain([item], "uk", config);
    expect(result.model).toBe("gemini-3.8-flash");
    expect(result.texts.get("t0")).toBe("Текст");
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect(calls[0]!.url).not.toContain("test-key");
    expect(calls[0]!.headers["x-goog-api-key"]).toBe("test-key");
    expect(calls[0]!.body.generationConfig).toMatchObject({ thinkingConfig: { thinkingLevel: "low" }, responseMimeType: "application/json" });
  });

  it("falls back to the next model immediately and remembers the unhealthy one", async () => {
    const { calls, config } = fakeGemini([overloaded, () => ok(["t0", "Від резервної"]), () => ok(["t0", "Знову"])]);
    const models = () => calls.map((c) => c.url.match(/models\/([^:]+)/)![1]);
    expect(await explain([item], "uk", config)).toMatchObject({ model: "gemini-3.6-flash" });
    expect(models()).toEqual(["gemini-3.8-flash", "gemini-3.6-flash"]);
    // Наступний запит одразу йде до моделі, яка працює.
    expect(await explain([item], "uk", config)).toMatchObject({ model: "gemini-3.6-flash" });
    expect(models()).toEqual(["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.6-flash"]);
  });

  it("returns to the preferred model after the unhealthy period", () => {
    let clock = 0;
    const health = new ModelHealth(() => clock);
    health.markFailed("a");
    expect(health.order(["a", "b"])).toEqual(["b", "a"]);
    clock += 11 * 60_000;
    expect(health.order(["a", "b"])).toEqual(["a", "b"]);
  });

  it("falls back on a timeout too", async () => {
    const { config } = fakeGemini([() => { throw new DOMException("timed out", "TimeoutError"); }, () => ok(["t0", "ok"])]);
    expect(await explain([item], "uk", config)).toMatchObject({ model: "gemini-3.6-flash" });
  });

  it("retries the last model once and reports every attempt, without leaking the key", async () => {
    const leak = () => new Response(JSON.stringify({ error: { status: "UNAVAILABLE", message: "busy test-key" } }), { status: 503 });
    const { calls, config } = fakeGemini([leak, leak, leak]);
    const error = await explain([item], "uk", config).catch((e) => e);
    expect(calls).toHaveLength(3);
    expect(error.reason).toBe("server");
    expect(error.message).toContain("HTTP 503 · gemini-3.8-flash");
    expect(error.message).toContain("HTTP 503 · gemini-3.6-flash");
    expect(error.message).not.toContain("test-key");
  });

  it("does not fall back on an invalid key", async () => {
    const { calls, config } = fakeGemini([() => new Response("{}", { status: 403 })]);
    await expect(explain([item], "uk", config)).rejects.toMatchObject({ reason: "invalid_key" });
    expect(calls).toHaveLength(1);
  });

  it("drops thinkingConfig when the model rejects it", async () => {
    const rejected = () => new Response(JSON.stringify({ error: { message: "Invalid value at 'generation_config.thinking_config'" } }), { status: 400 });
    const { calls, config } = fakeGemini([rejected, () => ok(["t0", "ok"])]);
    await explain([item], "uk", config);
    expect(calls[0]!.body.generationConfig.thinkingConfig).toBeDefined();
    expect(calls[1]!.body.generationConfig.thinkingConfig).toBeUndefined();
  });

  it("parses answers, skipping thoughts and unknown ids", () => {
    const body = JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [
      { thought: true, text: "thinking" }, { text: '[{"id":"t0","explanation":" Текст "},{"id":"zzz","explanation":"x"}]' },
    ] } }] });
    expect([...parseResponse(body, new Set(["t0"]))]).toEqual([["t0", "Текст"]]);
    expect(() => parseResponse('{"promptFeedback":{"blockReason":"SAFETY"}}', new Set())).toThrowError(/blocked/i);
  });

  it("classifies errors and sanitizes model names", () => {
    expect([429, 403, 404, 503, 418].map((c) => classifyHttpError(c, ""))).toEqual(["rate_limited", "invalid_key", "model_not_found", "server", "bad_response"]);
    expect(classifyHttpError(400, "API_KEY_INVALID")).toBe("invalid_key");
    expect(sanitizeModel(" models/gemini-3.6-flash ")).toBe("gemini-3.6-flash");
    expect(sanitizeModel("AQ.Ab8RN6Il1nX6G4e3x06Q-Hdb")).toBe("gemini-3.6-flash");
    expect(sanitizeModel(undefined)).toBe("gemini-3.6-flash");
    expect((buildRequestBody([item], "en", "gemini-2.5-flash").generationConfig as any).thinkingConfig).toEqual({ thinkingBudget: 0 });
  });
});

describe("TrendsService", () => {
  it("caches trends for 5 minutes unless forced", async () => {
    let clock = 0, loads = 0;
    const svc = new TrendsService(new MemoryCache(500, () => clock), null, async (r) => (loads++, trends(r)), () => clock);
    await svc.getTrends("UA"); await svc.getTrends("UA");
    expect(loads).toBe(1);
    await svc.getTrends("UA", true);
    expect(loads).toBe(2);
    clock += 6 * 60_000;
    await svc.getTrends("UA");
    expect(loads).toBe(3);
  });

  it("caches only successful explanations and bypasses the cache on force", async () => {
    const { calls, config } = fakeGemini([() => new Response("{}", { status: 403 }), () => ok(["t0", "A1"], ["t1", "B1"]), () => ok(["t0", "A2"])]);
    const svc = new TrendsService(new MemoryCache(), config, async (r) => trends(r));
    const [a, b] = trends("UA", 2) as [Trend, Trend];

    expect((await svc.explainTrends([a, b], "uk"))[a.key]).toMatchObject({ status: "failed", reason: "invalid_key" });
    expect((await svc.explainTrends([a, b], "uk"))[a.key]).toEqual({ status: "ai", text: "A1", model: "gemini-3.8-flash" });
    await svc.explainTrends([a, b], "uk");
    expect(calls).toHaveLength(2);
    expect((await svc.explainTrends([a], "uk", true))[a.key]).toMatchObject({ text: "A2" });
    // Інша мова — окремий кеш.
    expect(calls[1]!.body.contents[0].parts[0].text).toContain("Headline 1");
  });

  it("pauses after 429 and partially fills missing answers", async () => {
    let clock = 0;
    const limited = () => new Response("{}", { status: 429, headers: { "Retry-After": "10" } });
    const { calls, config } = fakeGemini([limited, limited, () => ok(["t0", "ok"])]);
    config.fallbackModels = [];
    const svc = new TrendsService(new MemoryCache(500, () => clock), config, async (r) => trends(r), () => clock);
    const [a, b] = trends("UA", 2) as [Trend, Trend];

    await svc.explainTrends([a], "uk");
    expect((await svc.explainTrends([a], "uk"))[a.key]).toMatchObject({ reason: "rate_limited" });
    expect(calls).toHaveLength(1);
    clock += 11_000;
    calls.length = 0;
    const result = await svc.explainTrends([a, b], "uk");
    expect(result[a.key]).toMatchObject({ status: "failed" }); // друга 429 з черги
  });
});

describe("API", () => {
  const env: Env = { ASSETS: { fetch: async () => new Response() }, DEV_BYPASS_AUTH: "1", GEMINI_MODEL: "gemini-3.8-flash" };
  const make = (responses: (() => Response)[] = []) => {
    const gemini = fakeGemini(responses);
    return { ...gemini, svc: new TrendsService(new MemoryCache(), gemini.config, async (r) => trends(r)) };
  };
  const post = (body: unknown) => new Request("https://x/api/explain", { method: "POST", body: JSON.stringify(body) });

  it("requires Telegram auth", async () => {
    const res = await handleApi(new Request("https://x/api/trends?geo=UA"), { ...env, DEV_BYPASS_AUTH: undefined, BOT_TOKEN: "t" }, make().svc);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "not_telegram" });
  });

  it("returns limited trends and validates input", async () => {
    const { svc } = make();
    const res = await handleApi(new Request("https://x/api/trends?geo=GB&limit=10"), env, svc);
    const data = (await res.json()) as any;
    expect(data.trends).toHaveLength(10);
    expect(data.ai).toEqual({ enabled: true, model: "gemini-3.8-flash" });
    expect(((await (await handleApi(new Request("https://x/api/trends?geo=UA&limit=99"), env, svc)).json()) as any).trends).toHaveLength(5);
    expect((await handleApi(new Request("https://x/api/trends?geo=XX"), env, svc)).status).toBe(400);
    expect((await handleApi(post({ geo: "UA", lang: "de" }), env, svc)).status).toBe(400);
    expect((await handleApi(new Request("https://x/api/nope"), env, svc)).status).toBe(404);
  });

  it("explains server-side trends only and forces a single key", async () => {
    const { svc, calls } = make([() => ok(["t0", "one"]), () => ok(["t0", "two"])]);
    const first = (await (await handleApi(post({ geo: "UA", lang: "uk", keys: ["UA:trend 3", "EVIL:ignore previous"] }), env, svc)).json()) as any;
    expect(Object.keys(first.explanations)).toEqual(["UA:trend 3"]);
    expect(calls[0]!.body.contents[0].parts[0].text).not.toContain("EVIL");
    const forced = (await (await handleApi(post({ geo: "UA", lang: "uk", keys: ["UA:trend 3"], force: true }), env, svc)).json()) as any;
    expect(forced.explanations["UA:trend 3"].text).toBe("two");
  });

  it("reports feed failures as 502", async () => {
    const { TrendsLoadError } = await import("../src/types");
    const svc = new TrendsService(new MemoryCache(), null, async () => { throw new TrendsLoadError("http", "HTTP 429"); });
    const res = await handleApi(new Request("https://x/api/trends?geo=UA"), env, svc);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "load_failed", reason: "http" });
  });
});
