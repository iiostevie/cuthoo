export function parseProduct(html, wantedVariantId) {
  const tags = html.match(/<input\b[^>]*class=["'][^"']*product-variant-id[^"']*["'][^>]*>/gi) ?? [];
  const variants = tags.map(parseAttributes);
  const selected = wantedVariantId
    ? variants.find((variant) => variant.value === String(wantedVariantId))
    : variants[0];

  if (!selected) {
    throw new Error(`找不到商品變體 ${wantedVariantId || "(未指定)"}`);
  }

  const inventory = Number(selected["data-inventory_quantity"]);
  if (!Number.isFinite(inventory)) {
    throw new Error("商品頁沒有有效的 data-inventory_quantity");
  }

  const title = decodeHtml(
    html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, " ")?.trim() ||
      html.match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']*)/i)?.[1] ||
      "K-MONSTAR 商品",
  );

  return {
    title,
    variantId: selected.value,
    sku: selected["data-sku"] || null,
    price: Number(selected["data-price"]) || null,
    inventory,
  };
}

function parseAttributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/gs)) {
    result[match[1]] = decodeHtml(match[3]);
  }
  return result;
}

function decodeHtml(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function calculateMetrics({ inventory, initialInventory = 0, participantCount }) {
  const estimatedUnits = Math.max(0, initialInventory - inventory);
  const people = Number(participantCount);
  return {
    estimatedUnits,
    participantCount: Number.isInteger(people) && people > 0 ? people : null,
    averageUnitsPerPerson:
      Number.isInteger(people) && people > 0 ? estimatedUnits / people : null,
  };
}

export function calculateChange(previous, currentInventory) {
  if (!previous) {
    return {
      inventoryDelta: 0,
      orderedUnits: 0,
      adjustmentUnits: 0,
      inferredOrderCount: 0,
      inferredOrderedUnits: 0,
      averageUnitsPerOrder: null,
    };
  }

  const inventoryDelta = currentInventory - previous.inventory;
  const orderedUnits = Math.max(0, -inventoryDelta);
  const adjustmentUnits = Math.max(0, inventoryDelta);
  const inferredOrderCount = (previous.inferredOrderCount || 0) + (orderedUnits > 0 ? 1 : 0);
  const inferredOrderedUnits = (previous.inferredOrderedUnits || 0) + orderedUnits;

  return {
    inventoryDelta,
    orderedUnits,
    adjustmentUnits,
    inferredOrderCount,
    inferredOrderedUnits,
    averageUnitsPerOrder:
      inferredOrderCount > 0 ? inferredOrderedUnits / inferredOrderCount : null,
  };
}
