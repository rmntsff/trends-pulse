/** Країни, для яких Google Trends публікує RSS. */
export const REGIONS = ["UA", "US", "GB", "DE", "PL", "FR", "CA", "JP", "IT", "ES"] as const;
export type Region = (typeof REGIONS)[number];

export const LANGUAGES = ["uk", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

export interface NewsArticle {
  title: string;
  url: string | null;
  source: string;
  snippet: string;
}

export interface Trend {
  /** Стабільний ключ у межах країни: `UA:назва у нижньому регістрі`. */
  key: string;
  region: Region;
  rank: number;
  title: string;
  /** Наприклад "200+". null, якщо в RSS немає. */
  approxTraffic: string | null;
  publishedAtMillis: number | null;
  imageUrl: string | null;
  news: NewsArticle[];
  /** Новина, якщо є, інакше пошук Google. */
  openUrl: string;
  searchUrl: string;
}

export type AiFailure =
  | "rate_limited"
  | "invalid_key"
  | "model_not_found"
  | "network"
  | "blocked"
  | "bad_response"
  | "server";

export type Explanation =
  | { status: "ai"; text: string; model: string }
  | { status: "failed"; reason: AiFailure; detail: string | null };

export type LoadError = "network" | "http" | "parse";

export class TrendsLoadError extends Error {
  constructor(
    readonly error: LoadError,
    message: string,
  ) {
    super(message);
  }
}

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  BOT_TOKEN?: string;
  ALLOWED_USER_IDS?: string;
  DEV_BYPASS_AUTH?: string;
}
