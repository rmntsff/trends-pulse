import type { Env } from "./types";

const WEBHOOK_PATH = "/telegram/webhook";
const WELCOME =
  "Привіт! Я показую, що просто зараз шукають у Google, і коротко пояснюю чому.\n\n" +
  "🔥 Топ трендів України, США та ще однієї країни на вибір\n" +
  "✨ До кожного — 1–2 речення від Gemini\n\n" +
  "Натисніть кнопку нижче, щоб відкрити застосунок.";

/**
 * Секрет, яким Telegram підписує кожне звернення до webhook (заголовок
 * X-Telegram-Bot-Api-Secret-Token). Виводиться з токена бота, тож окремо його задавати не треба.
 */
export async function webhookSecret(botToken: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(botToken), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode("trends-pulse-webhook"));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

/**
 * Приймає повідомлення від Telegram. На будь-яке повідомлення в особистому чаті
 * відповідає привітанням із кнопкою, що відкриває Mini App.
 * Відповідь віддається прямо в тілі (метод sendMessage), без окремого запиту до Telegram.
 */
export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.BOT_TOKEN) return json({ error: "server_misconfigured" }, 503);
  const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!timingSafeEqual(provided, await webhookSecret(env.BOT_TOKEN))) return json({ error: "forbidden" }, 403);

  let update: { message?: { chat?: { id?: unknown; type?: unknown } } };
  try {
    update = await request.json();
  } catch {
    return json({ ok: true });
  }
  const chat = update.message?.chat;
  // Кнопки web_app працюють лише в особистих чатах; усе інше мовчки підтверджуємо.
  if (typeof chat?.id !== "number" || chat.type !== "private") return json({ ok: true });

  return json({
    method: "sendMessage",
    chat_id: chat.id,
    text: WELCOME,
    reply_markup: { inline_keyboard: [[{ text: "🔥 Відкрити тренди", web_app: { url: new URL(request.url).origin } }]] },
  });
}

async function callTelegram(botToken: string, method: string, body: unknown, fetcher: typeof fetch): Promise<string | null> {
  try {
    const response = await fetcher(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json()) as { ok?: boolean; description?: string };
    return data.ok ? null : (data.description ?? `HTTP ${response.status}`);
  } catch {
    return "немає зв'язку з Telegram";
  }
}

/**
 * Одноразове налаштування: відкрийте https://ВАША-АДРЕСА/setup у браузері.
 * Повідомляє Telegram адресу webhook і реєструє команди. Безпечно викликати повторно
 * і будь-кому: щоразу встановлюються ті самі значення, а токен ніде не показується.
 */
export async function handleSetup(request: Request, env: Env, fetcher: typeof fetch = fetch): Promise<Response> {
  const text = (body: string, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (!env.BOT_TOKEN) return text("❌ Не задано секрет BOT_TOKEN.", 503);

  const origin = new URL(request.url).origin;
  const errors = [
    await callTelegram(env.BOT_TOKEN, "setWebhook", {
      url: origin + WEBHOOK_PATH,
      secret_token: await webhookSecret(env.BOT_TOKEN),
      allowed_updates: ["message"],
      drop_pending_updates: true,
    }, fetcher),
    await callTelegram(env.BOT_TOKEN, "setMyCommands", {
      commands: [
        { command: "start", description: "Відкрити тренди" },
        { command: "help", description: "Що вміє бот" },
      ],
    }, fetcher),
  ].filter((e): e is string => e !== null);

  if (errors.length > 0) return text(`❌ Telegram відповів помилкою: ${errors.join("; ").split(env.BOT_TOKEN).join("***")}`, 502);
  return text("✅ Готово. Бот тепер відповідає на /start. Надішліть йому /start у Telegram, щоб перевірити.");
}

export { WEBHOOK_PATH };
