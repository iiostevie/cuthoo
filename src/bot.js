import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Client, GatewayIntentBits } from "discord.js";
import { loadDotEnv } from "./env.js";
import { calculateChange } from "./parser.js";
import { fetchProduct, normalizeProductUrl } from "./product.js";
import { SubscriptionStore } from "./store.js";

loadDotEnv();

const token = process.env.DISCORD_BOT_TOKEN;
const prefix = process.env.COMMAND_PREFIX || "!cuthoo";
const intervalMs = Math.max(10, Number(process.env.POLL_INTERVAL_SECONDS) || 30) * 1000;
const subscriptionsFile = resolve(process.env.SUBSCRIPTIONS_FILE || "./data/subscriptions.json");
const eventsFile = resolve(process.env.EVENTS_FILE || "./data/events.jsonl");
if (!token) {
  console.error("缺少 DISCORD_BOT_TOKEN，請填入 .env。 ");
  process.exit(1);
}

const store = new SubscriptionStore(subscriptionsFile);
await store.load();
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
let polling = false;

client.once("ready", () => {
  console.log(`Cuthoo 已登入：${client.user.tag}｜訂閱 ${store.items.length} 個商品`);
  void pollAll();
  setInterval(pollAll, intervalMs);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.content.trim().startsWith(prefix)) return;
  const input = message.content.trim().slice(prefix.length).trim();
  const [command = "help", ...args] = input.split(/\s+/);
  try {
    if (["add", "訂閱"].includes(command.toLowerCase())) await addSubscription(message, args);
    else if (["remove", "移除", "取消"].includes(command.toLowerCase())) await removeSubscription(message, args[0]);
    else if (["list", "列表"].includes(command.toLowerCase())) await listSubscriptions(message);
    else if (["status", "狀態"].includes(command.toLowerCase())) await showStatus(message, args[0]);
    else await message.reply(helpText());
  } catch (error) {
    await message.reply(`❌ ${error.message}`);
  }
});

async function addSubscription(message, args) {
  if (!args[0]) throw new Error(`用法：${prefix} add <商品網址> [自訂名稱]`);
  const url = normalizeProductUrl(args[0]);
  const product = await fetchProduct(url);
  const id = makeId(product.variantId);
  const item = {
    id,
    channelId: message.channelId,
    guildId: message.guildId,
    url,
    title: args.slice(1).join(" ") || product.title,
    variantId: product.variantId,
    sku: product.sku,
    inventory: product.inventory,
    estimatedUnits: Math.max(0, -product.inventory),
    inferredOrderCount: 0,
    inferredOrderedUnits: 0,
    averageUnitsPerOrder: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    consecutiveErrors: 0,
  };
  const result = await store.add(item);
  if (!result.created) {
    await message.reply(`ℹ️ 此頻道已訂閱 **${result.item.title}**（ID：\`${result.item.id}\`）。`);
    return;
  }
  await message.reply([
    `✅ 已訂閱 **${item.title}**`,
    `ID：\`${item.id}\`｜變體：\`${item.variantId}\``,
    `基準庫存：\`${item.inventory}\`｜目前推算：**${item.estimatedUnits} 本**`,
    "基準不算訂單；下一次變化才從第 1 筆開始。",
  ].join("\n"));
}

async function removeSubscription(message, id) {
  if (!id) throw new Error(`用法：${prefix} remove <商品 ID>`);
  const removed = await store.remove(id, message.channelId);
  if (!removed) throw new Error("此頻道找不到該商品 ID");
  await message.reply(`🛑 已停止監控 **${removed.title}**（\`${removed.id}\`）。`);
}

async function listSubscriptions(message) {
  const items = store.forChannel(message.channelId);
  if (!items.length) {
    await message.reply(`此頻道尚未訂閱商品。使用：${prefix} add <商品網址>`);
    return;
  }
  await message.reply(items.map((item) =>
    `• \`${item.id}\` **${item.title}**\n  累計 ${item.estimatedUnits} 本｜推定 ${item.inferredOrderCount} 單｜平均 ${formatAverage(item.averageUnitsPerOrder)}`
  ).join("\n"));
}

async function showStatus(message, id) {
  const items = id ? [store.find(id, message.channelId)].filter(Boolean) : store.forChannel(message.channelId);
  if (!items.length) throw new Error("找不到訂閱商品");
  await message.reply(items.map(statusText).join("\n\n"));
}

async function pollAll() {
  if (polling) return;
  polling = true;
  try {
    for (const item of [...store.items]) await pollOne(item);
    await store.save();
  } finally {
    polling = false;
  }
}

async function pollOne(item) {
  try {
    const product = await fetchProduct(item.url, item.variantId);
    const change = calculateChange(item, product.inventory);
    item.consecutiveErrors = 0;
    item.updatedAt = new Date().toISOString();
    item.estimatedUnits = Math.max(0, -product.inventory);
    Object.assign(item, change);
    item.inventory = product.inventory;

    if (change.inventoryDelta === 0) return;
    await mkdir(dirname(eventsFile), { recursive: true });
    await appendFile(eventsFile, `${JSON.stringify({ timestamp: item.updatedAt, subscriptionId: item.id, ...item })}\n`, "utf8");
    const channel = await client.channels.fetch(item.channelId);
    if (channel?.isTextBased()) await channel.send(eventText(item, change));
  } catch (error) {
    item.consecutiveErrors = (item.consecutiveErrors || 0) + 1;
    console.error(`[${item.id}] ${error.message}`);
    if (item.consecutiveErrors === 3) {
      const channel = await client.channels.fetch(item.channelId).catch(() => null);
      if (channel?.isTextBased()) await channel.send(`⚠️ **${item.title}** 已連續監控失敗 3 次：${error.message}`);
    }
  }
}

function eventText(item, change) {
  const detail = change.orderedUnits > 0
    ? `**${item.inferredOrderCount}.** 目前庫存：\`${item.inventory}\`｜與前次相比：**${signed(change.inventoryDelta)}**｜推定本單：**${change.orderedUnits} 本**`
    : `↩️ 目前庫存：\`${item.inventory}\`｜與前次相比：**${signed(change.inventoryDelta)}**｜取消／調整：**${change.adjustmentUnits} 本**`;
  return [
    `📊 **${item.title}**（\`${item.id}\`）`,
    detail,
    `推定累計：**${item.estimatedUnits} 本**`,
    `推定訂單：**${item.inferredOrderCount} 筆**｜下單事件合計：**${item.inferredOrderedUnits} 本**`,
    `平均每單：**${formatAverage(item.averageUnitsPerOrder)}**`,
  ].join("\n");
}

function statusText(item) {
  return [
    `📦 **${item.title}**（\`${item.id}\`）`,
    `庫存：\`${item.inventory}\`｜推定累計：**${item.estimatedUnits} 本**`,
    `推定訂單：**${item.inferredOrderCount} 筆**｜平均每單：**${formatAverage(item.averageUnitsPerOrder)}**`,
    item.url,
  ].join("\n");
}

function helpText() {
  return [
    "**Cuthoo 指令**",
    `\`${prefix} add <商品網址> [自訂名稱]\`－訂閱商品`,
    `\`${prefix} list\`－本頻道訂閱列表`,
    `\`${prefix} status [商品 ID]\`－查看狀態`,
    `\`${prefix} remove <商品 ID>\`－取消訂閱`,
  ].join("\n");
}

function makeId(variantId) {
  return `c${variantId}`;
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}

function formatAverage(value) {
  return value == null ? "N/A" : `${value.toFixed(2)} 本`;
}

await client.login(token);
