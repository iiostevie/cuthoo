import test from "node:test";
import assert from "node:assert/strict";
import { nextPollDelaySeconds, normalizeProductUrl } from "../worker/monitor.ts";
import { fetchProductSnapshot } from "../worker/monitor.ts";

test("只接受指定商店的 HTTPS 商品頁", () => {
  assert.equal(
    normalizeProductUrl("https://www.kmonstar.com.tw/products/example?tracking=1#top"),
    "https://www.kmonstar.com.tw/products/example",
  );
  assert.throws(() => normalizeProductUrl("https://example.com/products/example"));
  assert.throws(() => normalizeProductUrl("http://www.kmonstar.com.tw/products/example"));
});

test("推薦商品的已售完不會誤判主商品", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`<script type="application/ld+json">{"availability":"InStock"}</script>
    <input class="product-variant-id" value="1" data-inventory_quantity="-12">
    <button disabled>其他按鈕</button><section class="recommendation"><button disabled>已售完</button></section>`);
  try {
    const snapshot = await fetchProductSnapshot("https://www.kmonstar.com.tw/products/test");
    assert.equal(snapshot.inventory, -12);
    assert.equal(snapshot.soldOut, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("台灣時間一般五分鐘、凌晨 01:00–07:00 三十分鐘輪詢", () => {
  assert.equal(nextPollDelaySeconds(Date.parse("2026-08-20T00:00:00Z")), 300); // 台灣 08:00
  assert.equal(nextPollDelaySeconds(Date.parse("2026-08-20T18:00:00Z")), 1800); // 台灣 02:00
  assert.equal(nextPollDelaySeconds(Date.parse("2026-08-20T16:59:00Z")), 60); // 下次在 01:00 切換
  assert.equal(nextPollDelaySeconds(Date.parse("2026-08-20T16:59:30Z")), 30);
  assert.equal(nextPollDelaySeconds(Date.parse("2026-08-20T22:59:00Z")), 60); // 下次在 07:00 切換
});
