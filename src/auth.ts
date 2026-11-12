import type { Env } from "./types";

export interface TelegramUser {
  id: number;
  firstName: string;
}

export type AuthResult =
  | { ok: true; user: TelegramUser }
  /** 401: запит не з Telegram або підпис недійсний. 403: користувач справжній, але доступу немає. */
  | { ok: false; status: 401 | 403; code: "not_telegram" | "bad_signature" | "expired" | "not_allowed" | "server_misconfigured"; userId?: number };

const MAX_AGE_SECONDS = 24 * 60 * 60;
const encoder = new TextEncoder();

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Порівняння без витоку часу виконання. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Перевіряє підпис `initData`, який Telegram передає Mini App.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * Підробити його без токена бота неможливо, тому `user.id` можна довіряти.
 */
export async function verifyInitData(
  initData: string,
  botToken: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<{ ok: true; user: TelegramUser } | { ok: false; code: "bad_signature" | "expired" }> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, code: "bad_signature" };
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secret = await hmacSha256(encoder.encode("WebAppData"), botToken);
  const expected = toHex(await hmacSha256(secret, dataCheckString));
  if (!timingSafeEqual(expected, hash.toLowerCase())) return { ok: false, code: "bad_signature" };

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || nowSeconds - authDate > MAX_AGE_SECONDS) return { ok: false, code: "expired" };

  try {
    const user = JSON.parse(params.get("user") ?? "") as { id?: unknown; first_name?: unknown };
    if (typeof user.id !== "number") return { ok: false, code: "bad_signature" };
    return { ok: true, user: { id: user.id, firstName: typeof user.first_name === "string" ? user.first_name : "" } };
  } catch {
    return { ok: false, code: "bad_signature" };
  }
}

export function parseAllowedIds(raw: string | undefined): Set<number> {
  return new Set(
    (raw ?? "")
      .split(/[\s,;]+/)
      .map((part) => Number(part))
      .filter((id) => Number.isInteger(id) && id > 0),
  );
}

/**
 * Єдине місце, де вирішується, чи має користувач доступ.
 * Зараз це список ALLOWED_USER_IDS. Платний доступ (наприклад, через Telegram Stars)
 * додається тут: перевірка активної підписки користувача в сховищі.
 */
export function hasAccess(user: TelegramUser, env: Env): boolean {
  return parseAllowedIds(env.ALLOWED_USER_IDS).has(user.id);
}

/** Заголовок: `Authorization: tma <initData>`. */
export async function authenticate(request: Request, env: Env): Promise<AuthResult> {
  if (env.DEV_BYPASS_AUTH === "1") return { ok: true, user: { id: 0, firstName: "dev" } };
  if (!env.BOT_TOKEN) return { ok: false, status: 401, code: "server_misconfigured" };

  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("tma ") || header.length <= 4) return { ok: false, status: 401, code: "not_telegram" };

  const verified = await verifyInitData(header.slice(4), env.BOT_TOKEN);
  if (!verified.ok) return { ok: false, status: 401, code: verified.code };
  if (!hasAccess(verified.user, env)) {
    // ID повертаємо, щоб власник міг додати людину в ALLOWED_USER_IDS.
    return { ok: false, status: 403, code: "not_allowed", userId: verified.user.id };
  }
  return { ok: true, user: verified.user };
}
