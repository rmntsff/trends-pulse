import { describe, expect, it } from "vitest";
import { handleSetup, handleWebhook, webhookSecret } from "../src/bot";
import type { Env } from "../src/types";

const BOT_TOKEN = "123456:TEST-TOKEN";
const env: Env = { ASSETS: { fetch: async () => new Response() }, BOT_TOKEN };
const update = (chat: unknown, secret?: string) =>
  new Request("https://app.example/telegram/webhook", {
    method: "POST",
    headers: secret ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {},
    body: JSON.stringify({ update_id: 1, message: { text: "/start", chat } }),
  });

describe("webhook", () => {
  it("rejects requests without the secret token", async () => {
    expect((await handleWebhook(update({ id: 5, type: "private" }), env)).status).toBe(403);
    expect((await handleWebhook(update({ id: 5, type: "private" }, "wrong"), env)).status).toBe(403);
  });

  it("replies in private chats with a button that opens the Mini App", async () => {
    const res = await handleWebhook(update({ id: 5, type: "private" }, await webhookSecret(BOT_TOKEN)), env);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ method: "sendMessage", chat_id: 5 });
    expect(body.reply_markup.inline_keyboard[0][0].web_app.url).toBe("https://app.example");
  });

  it("stays silent in groups and on malformed updates", async () => {
    const secret = await webhookSecret(BOT_TOKEN);
    expect(await (await handleWebhook(update({ id: -1, type: "group" }, secret), env)).json()).toEqual({ ok: true });
    const garbage = new Request("https://app.example/telegram/webhook", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret }, body: "nope" });
    expect(await (await handleWebhook(garbage, env)).json()).toEqual({ ok: true });
  });
});

describe("setup", () => {
  it("registers the webhook and commands without exposing the token", async () => {
    const calls: { url: string; body: any }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;

    const res = await handleSetup(new Request("https://app.example/setup"), env, fetcher);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(BOT_TOKEN);
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["setWebhook", "setMyCommands"]);
    expect(calls[0]!.body).toMatchObject({ url: "https://app.example/telegram/webhook", secret_token: await webhookSecret(BOT_TOKEN) });
  });

  it("reports Telegram errors and a missing token", async () => {
    const failing = (async () => new Response(JSON.stringify({ ok: false, description: `Unauthorized ${BOT_TOKEN}` }), { status: 401 })) as unknown as typeof fetch;
    const res = await handleSetup(new Request("https://app.example/setup"), env, failing);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(BOT_TOKEN);
    expect((await handleSetup(new Request("https://app.example/setup"), { ...env, BOT_TOKEN: undefined }, failing)).status).toBe(503);
  });
});
