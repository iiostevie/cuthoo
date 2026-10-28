import { CuthooCoordinator } from "./coordinator";
import { timingSafeEqual } from "node:crypto";

export { CuthooCoordinator };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "cuthoo" });
    if (url.pathname === "/discord/interactions" && request.method === "POST") return handleDiscordInteraction(request, env, ctx);
    if (url.pathname.startsWith("/api/")) {
      if (!await authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      return coordinator(env, "portal").fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

function coordinator(env: Env, shard: string): DurableObjectStub {
  return env.CUTHOO.get(env.CUTHOO.idFromName(shard));
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  const token = request.headers.get("x-cuthoo-admin-token") || "";
  return Boolean(env.ADMIN_TOKEN) && await constantTimeEqual(token, env.ADMIN_TOKEN);
}

async function handleDiscordInteraction(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const signature = request.headers.get("x-signature-ed25519") || "";
  const timestamp = request.headers.get("x-signature-timestamp") || "";
  const body = await request.text();
  if (!await verifyDiscordRequest(env.DISCORD_PUBLIC_KEY, signature, timestamp, body)) return new Response("Bad signature", { status: 401 });
  const payload = JSON.parse(body) as { type: number; token: string; guild_id?: string };
  if (payload.type === 1) return Response.json({ type: 1 });
  if (payload.type !== 2) return Response.json({ type: 4, data: { content: "Unsupported interaction", flags: 64 } });
  ctx.waitUntil(processDiscordCommand(payload, env));
  return Response.json({ type: 5, data: { flags: 64 } });
}

async function processDiscordCommand(payload: { token: string; guild_id?: string }, env: Env): Promise<void> {
  const response = await coordinator(env, "portal").fetch("https://cuthoo.internal/discord/command", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  const result = await response.json<{ content?: string; error?: string }>();
  await fetch(`https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${payload.token}/messages/@original`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: result.content || `❌ ${result.error || "指令失敗"}`, allowed_mentions: { parse: [] } }),
  });
}

async function verifyDiscordRequest(publicKeyHex: string, signatureHex: string, timestamp: string, body: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", hexBuffer(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    const message = new TextEncoder().encode(timestamp + body);
    return await crypto.subtle.verify("Ed25519", key, hexBuffer(signatureHex), message.buffer as ArrayBuffer);
  } catch { return false; }
}

function hexBuffer(value: string): ArrayBuffer {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2) throw new Error("Invalid hex");
  return Uint8Array.from(value.match(/../g)!.map((byte) => Number.parseInt(byte, 16))).buffer;
}

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return timingSafeEqual(new Uint8Array(aHash), new Uint8Array(bHash));
}
