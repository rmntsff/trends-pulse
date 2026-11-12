import { authenticate } from "./auth";
import { handleSetup, handleWebhook, WEBHOOK_PATH } from "./bot";
import { EdgeCache, MemoryCache } from "./cache";
import { DEFAULT_FALLBACK_MODELS, isConfigured, sanitizeModel, type GeminiConfig } from "./gemini";
import { TrendsService } from "./service";
import { LANGUAGES, REGIONS, TrendsLoadError, type Env, type Language, type Region } from "./types";

const MAX_LIMIT = 10;
const DEFAULT_LIMIT = 5;

// Кеш у пам'яті спільний для всіх запитів одного екземпляра Worker.
const sharedCache = new EdgeCache(new MemoryCache());
let service: TrendsService | null = null;
let serviceFingerprint = "";

function geminiConfig(env: Env): GeminiConfig | null {
  if (!isConfigured(env.GEMINI_API_KEY)) return null;
  return { apiKey: env.GEMINI_API_KEY.trim(), model: sanitizeModel(env.GEMINI_MODEL), fallbackModels: DEFAULT_FALLBACK_MODELS };
}

function getService(env: Env): TrendsService {
  const fingerprint = `${env.GEMINI_API_KEY ?? ""}|${env.GEMINI_MODEL ?? ""}`;
  if (!service || fingerprint !== serviceFingerprint) {
    service = new TrendsService(sharedCache, geminiConfig(env));
    serviceFingerprint = fingerprint;
  }
  return service;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const isRegion = (value: unknown): value is Region => (REGIONS as readonly unknown[]).includes(value);
const isLanguage = (value: unknown): value is Language => (LANGUAGES as readonly unknown[]).includes(value);

function parseLimit(raw: unknown): number {
  const limit = Number(raw);
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT ? limit : DEFAULT_LIMIT;
}

export async function handleApi(request: Request, env: Env, svc: TrendsService = getService(env)): Promise<Response> {
  const url = new URL(request.url);

  const auth = await authenticate(request, env);
  if (!auth.ok) return json({ error: auth.code, userId: auth.userId ?? null }, auth.status);

  if (url.pathname === "/api/trends" && request.method === "GET") {
    const geo = url.searchParams.get("geo");
    if (!isRegion(geo)) return json({ error: "bad_request" }, 400);
    try {
      const snapshot = await svc.getTrends(geo, url.searchParams.get("refresh") === "1");
      return json({
        region: geo,
        updatedAtMillis: snapshot.fetchedAtMillis,
        trends: snapshot.trends.slice(0, parseLimit(url.searchParams.get("limit"))),
        ai: { enabled: svc.aiEnabled, model: sanitizeModel(env.GEMINI_MODEL) },
      });
    } catch (e) {
      if (e instanceof TrendsLoadError) return json({ error: "load_failed", reason: e.error }, 502);
      throw e;
    }
  }

  if (url.pathname === "/api/explain" && request.method === "POST") {
    let body: { geo?: unknown; lang?: unknown; limit?: unknown; keys?: unknown; force?: unknown };
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_request" }, 400);
    }
    if (!isRegion(body.geo) || !isLanguage(body.lang)) return json({ error: "bad_request" }, 400);

    try {
      const snapshot = await svc.getTrends(body.geo);
      let targets = snapshot.trends.slice(0, parseLimit(body.limit));
      if (Array.isArray(body.keys)) {
        const keys = new Set(body.keys.filter((k): k is string => typeof k === "string"));
        targets = snapshot.trends.slice(0, MAX_LIMIT).filter((trend) => keys.has(trend.key));
      }
      // Примусове оновлення — лише для одного тренду за раз, щоб не палити квоту.
      const force = body.force === true && targets.length === 1;
      return json({ explanations: await svc.explainTrends(targets, body.lang, force) });
    } catch (e) {
      if (e instanceof TrendsLoadError) return json({ error: "load_failed", reason: e.error }, 502);
      throw e;
    }
  }

  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === WEBHOOK_PATH && request.method === "POST") return handleWebhook(request, env);
    if (url.pathname === "/setup" && request.method === "GET") return handleSetup(request, env);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env);
      } catch (e) {
        console.error("Unhandled API error", e);
        return json({ error: "internal" }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
