import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authenticate, parseAllowedIds, verifyInitData } from "../src/auth";
import type { Env } from "../src/types";

const BOT_TOKEN = "123456:TEST-TOKEN";
const NOW = 1_800_000_000;

/** Підписує initData так само, як це робить Telegram. */
export function signInitData(fields: Record<string, string>, token = BOT_TOKEN): string {
  const dataCheckString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

const fields = (id = 42, authDate = NOW - 60) => ({
  auth_date: String(authDate),
  query_id: "AAE",
  user: JSON.stringify({ id, first_name: "Костя" }),
});

const env = (extra: Partial<Env> = {}): Env => ({ ASSETS: { fetch: async () => new Response() }, BOT_TOKEN, ...extra });
const request = (initData?: string) =>
  new Request("https://x/api/trends", { headers: initData ? { Authorization: `tma ${initData}` } : {} });

describe("verifyInitData", () => {
  it("accepts data signed with the bot token", async () => {
    expect(await verifyInitData(signInitData(fields()), BOT_TOKEN, NOW)).toEqual({ ok: true, user: { id: 42, firstName: "Костя" } });
  });
  it("rejects a wrong token, tampering, missing hash and stale data", async () => {
    expect(await verifyInitData(signInitData(fields(), "other:token"), BOT_TOKEN, NOW)).toEqual({ ok: false, code: "bad_signature" });
    const tampered = signInitData(fields()).replace("%22id%22%3A42", "%22id%22%3A1");
    expect(await verifyInitData(tampered, BOT_TOKEN, NOW)).toEqual({ ok: false, code: "bad_signature" });
    expect(await verifyInitData("user=%7B%7D", BOT_TOKEN, NOW)).toEqual({ ok: false, code: "bad_signature" });
    expect(await verifyInitData(signInitData(fields(42, NOW - 90_000)), BOT_TOKEN, NOW)).toEqual({ ok: false, code: "expired" });
  });
});

describe("authenticate", () => {
  const fresh = () => signInitData(fields(42, Math.floor(Date.now() / 1000)));

  it("allows listed users only and reports the id of others", async () => {
    expect(await authenticate(request(fresh()), env({ ALLOWED_USER_IDS: "7, 42" }))).toMatchObject({ ok: true });
    expect(await authenticate(request(fresh()), env({ ALLOWED_USER_IDS: "7" }))).toEqual({ ok: false, status: 403, code: "not_allowed", userId: 42 });
    expect(await authenticate(request(fresh()), env())).toMatchObject({ ok: false, status: 403 });
  });
  it("rejects requests without Telegram data or without a configured bot", async () => {
    expect(await authenticate(request(), env({ ALLOWED_USER_IDS: "42" }))).toMatchObject({ ok: false, status: 401, code: "not_telegram" });
    expect(await authenticate(request(fresh()), env({ BOT_TOKEN: undefined, ALLOWED_USER_IDS: "42" }))).toMatchObject({ ok: false, code: "server_misconfigured" });
  });
  it("parses id lists leniently", () => {
    expect([...parseAllowedIds(" 1,2;3\n4 abc -5 ")]).toEqual([1, 2, 3, 4]);
  });
});
