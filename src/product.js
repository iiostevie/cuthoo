import { parseProduct } from "./parser.js";

export function normalizeProductUrl(input) {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.hostname !== "www.kmonstar.com.tw") {
    throw new Error("目前只允許 https://www.kmonstar.com.tw 的商品網址");
  }
  if (!url.pathname.startsWith("/products/")) {
    throw new Error("請提供 K-MONSTAR 商品頁網址");
  }
  url.hash = "";
  url.search = "";
  return url.toString();
}

export async function fetchProduct(url, variantId = null) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Cuthoo/0.2 (+personal monitoring; low frequency)",
      accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`商品頁回傳 HTTP ${response.status}`);
  return parseProduct(await response.text(), variantId);
}
