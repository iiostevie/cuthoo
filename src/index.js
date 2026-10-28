import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadDotEnv } from "./env.js";
import { calculateChange, calculateMetrics, parseProduct } from "./parser.js";

loadDotEnv();

const config = {
  productUrl: process.env.PRODUCT_URL,
  variantId: process.env.VARIANT_ID || null,
  intervalMs: Math.max(10, Number(process.env.POLL_INTERVAL_SECONDS) || 30) * 1000,
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || null,
  participantCount: process.env.PARTICIPANT_COUNT || null,
  initialInventory: Number(process.env.INITIAL_INVENTORY || 0),
  dataFile: resolve(process.env.DATA_FILE || "./data/history.jsonl"),
  eventsFile: resolve(process.env.EVENTS_FILE || "./data/events.jsonl"),
  stateFile: resolve(process.env.STATE_FILE || "./data/state.json"),
};

if (!config.productUrl) {
  console.error("缺少 PRODUCT_URL；請複製 .env.example 為 .env。 ");
  process.exit(1);
}

const once = process.argv.includes("--once");
let running = false;

async function poll() {
  if (running) return;
  running = true;
  try {
    const response = await fetch(config.productUrl, {
      headers: {
        "user-agent": "Cuthoo/0.2 (+personal monitoring; low frequency)",
        accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`商品頁回傳 HTTP ${response.status}`);

    const product = parseProduct(await response.text(), config.variantId);
    const metrics = calculateMetrics({
      inventory: product.inventory,
      initialInventory: config.initialInventory,
      participantCount: config.participantCount,
    });
    const previous = await readJson(config.stateFile);
    const change = calculateChange(previous, product.inventory);
    const sample = {
      timestamp: new Date().toISOString(),
      url: config.productUrl,
      ...product,
      ...metrics,
      ...change,
      delta: previous ? metrics.estimatedUnits - previous.estimatedUnits : 0,
    };

    await mkdir(dirname(config.dataFile), { recursive: true });
    await appendFile(config.dataFile, `${JSON.stringify(sample)}\n`, "utf8");
    if (previous && change.inventoryDelta !== 0) {
      await appendFile(config.eventsFile, `${JSON.stringify(sample)}\n`, "utf8");
    }
    await writeFile(config.stateFile, `${JSON.stringify(sample, null, 2)}\n`, "utf8");
    printSample(sample);

    if (config.discordWebhookUrl && (!previous || sample.inventoryDelta !== 0)) {
      await notifyDiscord(sample, !previous);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] 監控失敗：${error.message}`);
  } finally {
    running = false;
  }
}

async function notifyDiscord(sample, firstRun) {
  const average = sample.averageUnitsPerPerson == null
    ? "N/A（沒有公開購買人數）"
    : `${sample.averageUnitsPerPerson.toFixed(2)} 本`;
  const content = [
    `📊 **${sample.title}**`,
    `推算累計：**${sample.estimatedUnits} 本**`,
    firstRun
      ? "首次建立基準（不計為訂單）"
      : sample.orderedUnits > 0
        ? `**${sample.inferredOrderCount}.** 目前庫存：\`${sample.inventory}\`｜與前次相比：**${formatDelta(sample.inventoryDelta)}**｜推定本單：**${sample.orderedUnits} 本**`
        : `↩️ 目前庫存：\`${sample.inventory}\`｜與前次相比：**${formatDelta(sample.inventoryDelta)}**｜取消／調整：**${sample.adjustmentUnits} 本**`,
    `推定訂單：**${sample.inferredOrderCount} 筆**｜推定下單合計：**${sample.inferredOrderedUnits} 本**`,
    `平均每單：**${sample.averageUnitsPerOrder == null ? "N/A" : `${sample.averageUnitsPerOrder.toFixed(2)} 本`}**`,
    `人均：**${average}**`,
    `更新：<t:${Math.floor(Date.parse(sample.timestamp) / 1000)}:F>`,
  ].join("\n");

  const response = await fetch(config.discordWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Discord webhook 回傳 HTTP ${response.status}`);
}

function printSample(sample) {
  const average = sample.averageUnitsPerPerson == null
    ? "N/A"
    : sample.averageUnitsPerPerson.toFixed(2);
  console.log(
    `[${sample.timestamp}] 推算 ${sample.estimatedUnits} 本｜庫存 ${sample.inventory}｜庫存變化 ${formatDelta(sample.inventoryDelta)}｜本次推定 ${sample.orderedUnits} 本｜第 ${sample.inferredOrderCount} 筆｜平均每單 ${sample.averageUnitsPerOrder?.toFixed(2) ?? "N/A"}｜人均 ${average}`,
  );
}

function formatDelta(value) {
  return value > 0 ? `+${value}` : String(value);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

await poll();
if (!once) {
  console.log(`每 ${config.intervalMs / 1000} 秒監控一次；按 Ctrl+C 停止。`);
  setInterval(poll, config.intervalMs);
}
