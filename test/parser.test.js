import test from "node:test";
import assert from "node:assert/strict";
import { calculateChange, calculateMetrics, parseProduct } from "../src/parser.js";

test("解析指定變體的公開庫存", () => {
  const html = `<h1>測試商品</h1><input class="product-variant-id" value="87296443" data-sku="ABC" data-price="690.0" data-inventory_quantity="-6">`;
  assert.deepEqual(parseProduct(html, "87296443"), {
    title: "測試商品",
    variantId: "87296443",
    sku: "ABC",
    price: 690,
    inventory: -6,
  });
});

test("把每次負向庫存變化視為一筆推定訂單", () => {
  const first = calculateChange({ inventory: -6 }, -12);
  assert.deepEqual(first, {
    inventoryDelta: -6,
    orderedUnits: 6,
    adjustmentUnits: 0,
    inferredOrderCount: 1,
    inferredOrderedUnits: 6,
    averageUnitsPerOrder: 6,
  });

  const second = calculateChange({ inventory: -12, inferredOrderCount: 1, inferredOrderedUnits: 6 }, -15);
  assert.equal(second.inferredOrderCount, 2);
  assert.equal(second.inferredOrderedUnits, 9);
  assert.equal(second.averageUnitsPerOrder, 4.5);
});

test("取消或補庫不計入推定訂單平均", () => {
  const result = calculateChange(
    { inventory: -15, inferredOrderCount: 2, inferredOrderedUnits: 9 },
    -13,
  );
  assert.equal(result.inventoryDelta, 2);
  assert.equal(result.adjustmentUnits, 2);
  assert.equal(result.inferredOrderCount, 2);
  assert.equal(result.averageUnitsPerOrder, 4.5);
});

test("由負庫存推算本數及選填人均", () => {
  assert.deepEqual(calculateMetrics({ inventory: -6, initialInventory: 0 }), {
    estimatedUnits: 6,
    participantCount: null,
    averageUnitsPerPerson: null,
  });
  assert.equal(
    calculateMetrics({ inventory: -6, initialInventory: 0, participantCount: 4 }).averageUnitsPerPerson,
    1.5,
  );
});
