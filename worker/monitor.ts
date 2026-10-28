import type { ProductSnapshot } from "./types";

export function normalizeProductUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.hostname !== "www.kmonstar.com.tw") throw new Error("目前只允許 K-MONSTAR HTTPS 商品網址");
  if (!url.pathname.startsWith("/products/")) throw new Error("請提供商品頁網址");
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function fetchProductSnapshot(url: string, variantId?: string): Promise<ProductSnapshot> {
  const response = await fetch(url, {
    headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Cuthoo/0.3 (authorized product availability monitor)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404 || response.status === 410) throw new MonitorError("PRODUCT_REMOVED", response.status);
  if (response.status === 403) throw new MonitorError("ACCESS_DENIED", 403);
  if (response.status === 429) throw new MonitorError("RATE_LIMITED", 429);
  if (!response.ok) throw new MonitorError("NETWORK_ERROR", response.status);

  const html = await readLimitedText(response, 2_000_000);
  const tags = html.match(/<input\b[^>]*class=["'][^"']*product-variant-id[^"']*["'][^>]*>/gi) ?? [];
  const variants = tags.map(parseAttributes);
  const selected = variantId ? variants.find((value) => value.value === variantId) : variants[0];
  if (!selected) throw new MonitorError("PARSE_ERROR", response.status);
  const inventory = Number(selected["data-inventory_quantity"]);
  if (!Number.isFinite(inventory)) throw new MonitorError("PARSE_ERROR", response.status);
  const rawTitle = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, " ").trim()
    || html.match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']*)/i)?.[1] || "K-MONSTAR 商品";
  // Only trust the product's structured availability. A page can contain disabled
  // buttons and sold-out recommendations that do not describe the monitored item.
  const soldOut = /availability["']?\s*:\s*["']?OutOfStock/i.test(html);
  const validUntil = html.match(/priceValidUntil["']?\s*:\s*["']([^"']+)/i)?.[1];
  return {
    title: decodeHtml(rawTitle), variantId: selected.value, sku: selected["data-sku"] || null,
    price: Number(selected["data-price"]) || null, inventory, soldOut,
    saleEnded: validUntil ? Date.parse(validUntil) < Date.now() : false,
  };
}

export class MonitorError extends Error {
  readonly reason: string;
  readonly httpStatus: number;
  constructor(reason: string, httpStatus: number) {
    super(`${reason}${httpStatus ? ` (HTTP ${httpStatus})` : ""}`);
    this.reason = reason;
    this.httpStatus = httpStatus;
  }
}

export function nextPollDelaySeconds(now = Date.now()): number {
  const taipeiSecond = ((Math.floor(now / 1000) + 8 * 3600) % 86_400 + 86_400) % 86_400;
  const overnight = taipeiSecond >= 3600 && taipeiSecond < 25_200;
  const intervalSeconds = overnight ? 1800 : 300;
  const boundarySecond = overnight ? 25_200 : taipeiSecond < 3600 ? 3600 : 90_000;
  return Math.min(intervalSeconds, boundarySecond - taipeiSecond);
}

function parseAttributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/gs)) result[match[1]] = decodeHtml(match[3]);
  return result;
}

function decodeHtml(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new MonitorError("PARSE_ERROR", response.status);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new MonitorError("PARSE_ERROR", response.status);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
