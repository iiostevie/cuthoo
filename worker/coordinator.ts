import { DurableObject } from "cloudflare:workers";
import { fetchProductSnapshot, MonitorError, nextPollDelaySeconds, normalizeProductUrl } from "./monitor";
import type { StopReason } from "./types";

type ProductRow = {
  id: string; url: string; title: string; variant_id: string; sku: string | null;
  inventory: number; estimated_units: number; inferred_order_count: number;
  inferred_ordered_units: number; change_count: number; changed_units_total: number;
  status: string; reason: StopReason | null;
  base_poll_seconds: number; stable_count: number; terminal_count: number; error_count: number;
  next_poll_at: number; auto_resume_at: number | null; last_success_at: number | null;
  final_window_until: number | null; updated_at: number; terminated_at: number | null;
};

export class CuthooCoordinator extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.initializeSchema());
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/api/products") return Response.json(this.listProducts());
      if (request.method === "POST" && url.pathname === "/api/products") return Response.json(await this.addProduct(await request.json()));
      if (request.method === "POST" && /^\/api\/products\/[^/]+\/action$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split("/")[3]);
        return Response.json(await this.productAction(id, await request.json()));
      }
      if (request.method === "GET" && /^\/api\/products\/[^/]+\/logs$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split("/")[3]);
        return Response.json(this.listChangeLogs(id));
      }
      if (request.method === "GET" && url.pathname === "/api/logs") return Response.json(this.listPollLogs(url.searchParams.get("product") || ""));
      if (request.method === "POST" && url.pathname === "/discord/command") return Response.json(await this.discordCommand(await request.json()));
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 400 });
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      "UPDATE products SET status='ACTIVE', reason=NULL, auto_resume_at=NULL WHERE status='PAUSED' AND auto_resume_at IS NOT NULL AND auto_resume_at<=?",
      now,
    );
    const expiredFinalWindows = [...this.sql.exec<{ id: string; title: string }>(
      "SELECT id,title FROM products WHERE status='ACTIVE' AND final_window_until IS NOT NULL AND final_window_until<=?",
      now,
    )];
    for (const product of expiredFinalWindows) {
      this.terminate(product.id, "FINAL_WINDOW_ENDED");
      await this.queueSystemNotice(product.id, `⏱️ **${product.title}** 最後兩小時監控已結束，已自動停止。`);
    }
    const due = [...this.sql.exec<ProductRow>(
      "SELECT * FROM products WHERE status='ACTIVE' AND next_poll_at<=? ORDER BY next_poll_at LIMIT 25",
      now,
    )];
    for (let index = 0; index < due.length; index += 5) {
      await Promise.all(due.slice(index, index + 5).map((product) => this.pollProduct(product)));
    }
    await this.flushOutbox();
    await this.scheduleNextAlarm();
  }

  private initializeSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY, url TEXT UNIQUE NOT NULL, title TEXT NOT NULL, variant_id TEXT NOT NULL,
      sku TEXT, inventory INTEGER NOT NULL, estimated_units INTEGER NOT NULL DEFAULT 0,
      inferred_order_count INTEGER NOT NULL DEFAULT 0, inferred_ordered_units INTEGER NOT NULL DEFAULT 0,
      change_count INTEGER NOT NULL DEFAULT 0, changed_units_total INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ACTIVE', reason TEXT, base_poll_seconds INTEGER NOT NULL DEFAULT 60,
      stable_count INTEGER NOT NULL DEFAULT 0, terminal_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0, next_poll_at INTEGER NOT NULL, auto_resume_at INTEGER,
      last_success_at INTEGER, final_window_until INTEGER, updated_at INTEGER NOT NULL, terminated_at INTEGER
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, guild_id TEXT, channel_id TEXT NOT NULL,
      custom_name TEXT, created_by TEXT, created_at INTEGER NOT NULL,
      UNIQUE(product_id, channel_id)
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS order_events (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, sequence_number INTEGER,
      previous_inventory INTEGER NOT NULL, current_inventory INTEGER NOT NULL,
      inventory_delta INTEGER NOT NULL, inferred_order_units INTEGER NOT NULL,
      event_type TEXT NOT NULL, observed_at INTEGER NOT NULL
    )`);
    const productColumns = new Set([...this.sql.exec<{ name: string }>("PRAGMA table_info(products)")].map((column) => column.name));
    if (!productColumns.has("change_count")) {
      this.sql.exec("ALTER TABLE products ADD COLUMN change_count INTEGER NOT NULL DEFAULT 0");
      this.sql.exec("UPDATE products SET change_count=(SELECT COUNT(*) FROM order_events e WHERE e.product_id=products.id)");
    }
    if (!productColumns.has("changed_units_total")) {
      this.sql.exec("ALTER TABLE products ADD COLUMN changed_units_total INTEGER NOT NULL DEFAULT 0");
      this.sql.exec("UPDATE products SET changed_units_total=COALESCE((SELECT SUM(ABS(e.inventory_delta)) FROM order_events e WHERE e.product_id=products.id),0)");
    }
    if (!productColumns.has("final_window_until")) {
      this.sql.exec("ALTER TABLE products ADD COLUMN final_window_until INTEGER");
    }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS notification_outbox (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      content TEXT NOT NULL, delivered_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, UNIQUE(event_id, channel_id)
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS poll_logs (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, outcome TEXT NOT NULL,
      previous_inventory INTEGER, current_inventory INTEGER, inventory_delta INTEGER,
      sold_out INTEGER, sale_ended INTEGER, reason TEXT, observed_at INTEGER NOT NULL,
      next_poll_at INTEGER
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS idx_products_due ON products(status, next_poll_at)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS idx_events_product ON order_events(product_id, observed_at DESC)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS idx_outbox_pending ON notification_outbox(delivered_at, created_at)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS idx_poll_logs_product ON poll_logs(product_id, observed_at DESC)");
  }

  private listProducts(): unknown[] {
    return [...this.sql.exec(`SELECT p.*,
      CASE WHEN p.change_count>0 THEN CAST(p.changed_units_total AS REAL)/p.change_count ELSE NULL END AS average_units_per_change,
      (SELECT COUNT(*) FROM subscriptions s WHERE s.product_id=p.id) AS subscriber_count
      FROM products p ORDER BY p.updated_at DESC`)];
  }

  private listPollLogs(productId: string): unknown[] {
    return [...this.sql.exec(
      "SELECT * FROM poll_logs WHERE product_id=? ORDER BY observed_at DESC LIMIT 200",
      productId,
    )];
  }

  private listChangeLogs(productId: string): unknown[] {
    return [...this.sql.exec(
      `SELECT observed_at, event_type AS outcome, previous_inventory, current_inventory,
        inventory_delta, NULL AS sold_out, NULL AS reason, NULL AS next_poll_at
        FROM order_events WHERE product_id=? ORDER BY observed_at DESC LIMIT 200`,
      productId,
    )];
  }

  private async addProduct(input: unknown): Promise<Record<string, unknown>> {
    const body = input as { url?: string; name?: string; authorizationConfirmed?: boolean; channelId?: string; guildId?: string; userId?: string };
    if (!body.authorizationConfirmed) throw new Error("新增前必須確認已取得網站監控授權");
    const url = normalizeProductUrl(body.url || "");
    const existing = [...this.sql.exec<ProductRow>("SELECT * FROM products WHERE url=?", url)][0];
    if (existing) {
      if (body.channelId) this.addSubscription(existing.id, body.channelId, body.guildId, body.userId, body.name);
      return { ...existing, created: false };
    }
    const snapshot = await fetchProductSnapshot(url);
    const now = Date.now();
    const id = `c${snapshot.variantId}`;
    this.sql.exec(`INSERT INTO products
      (id,url,title,variant_id,sku,inventory,estimated_units,status,next_poll_at,last_success_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'ACTIVE',?,?,?)`,
      id, url, body.name || snapshot.title, snapshot.variantId, snapshot.sku, snapshot.inventory,
      Math.max(0, -snapshot.inventory), now + nextPollDelaySeconds(now) * 1000, now, now,
    );
    this.insertPollLog(id, "BASELINE", null, snapshot.inventory, null, snapshot.soldOut, snapshot.saleEnded, null, now, now + nextPollDelaySeconds(now) * 1000);
    if (body.channelId) this.addSubscription(id, body.channelId, body.guildId, body.userId, body.name);
    await this.scheduleNextAlarm();
    return { id, title: body.name || snapshot.title, inventory: snapshot.inventory, estimated_units: Math.max(0, -snapshot.inventory), status: "ACTIVE", created: true };
  }

  private addSubscription(productId: string, channelId: string, guildId?: string, userId?: string, name?: string): void {
    this.sql.exec(`INSERT OR IGNORE INTO subscriptions(id,product_id,guild_id,channel_id,custom_name,created_by,created_at)
      VALUES(?,?,?,?,?,?,?)`, crypto.randomUUID(), productId, guildId || null, channelId, name || null, userId || null, Date.now());
  }

  private async productAction(id: string, input: unknown): Promise<Record<string, unknown>> {
    const { action } = input as { action?: string };
    const product = [...this.sql.exec<ProductRow>("SELECT * FROM products WHERE id=?", id)][0];
    if (!product) throw new Error("找不到商品");
    const now = Date.now();
    if (action === "pause") this.sql.exec("UPDATE products SET status='PAUSED',reason='MANUAL_PAUSE',auto_resume_at=NULL,final_window_until=NULL,updated_at=? WHERE id=?", now, id);
    else if (action === "resume") this.sql.exec("UPDATE products SET status='ACTIVE',reason=NULL,terminal_count=0,error_count=0,next_poll_at=?,auto_resume_at=NULL,final_window_until=NULL,terminated_at=NULL,updated_at=? WHERE id=?", now, now, id);
    else if (action === "final_two_hours") this.sql.exec("UPDATE products SET status='ACTIVE',reason=NULL,terminal_count=0,error_count=0,next_poll_at=?,auto_resume_at=NULL,final_window_until=?,terminated_at=NULL,updated_at=? WHERE id=?", now, now + 7_200_000, now, id);
    else if (action === "terminate") this.terminate(id, "MANUAL_UNSUBSCRIBE");
    else throw new Error("不支援的操作");
    await this.scheduleNextAlarm();
    return { id, action, ok: true };
  }

  private async pollProduct(product: ProductRow): Promise<void> {
    try {
      const snapshot = await fetchProductSnapshot(product.url, product.variant_id);
      const now = Date.now();
      const inventoryDelta = snapshot.inventory - product.inventory;
      const orderedUnits = Math.max(0, -inventoryDelta);
      const adjustmentUnits = Math.max(0, inventoryDelta);
      const changed = inventoryDelta !== 0;
      const terminalCount = snapshot.soldOut || snapshot.saleEnded ? product.terminal_count + 1 : 0;
      if (terminalCount >= 3) {
        this.terminate(product.id, snapshot.saleEnded ? "SALE_ENDED" : "OUT_OF_STOCK");
        this.insertPollLog(product.id, "TERMINATED", product.inventory, snapshot.inventory, inventoryDelta, snapshot.soldOut, snapshot.saleEnded, snapshot.saleEnded ? "SALE_ENDED" : "OUT_OF_STOCK", now, null);
        await this.queueSystemNotice(product.id, `⛔ **${product.title}** 已停止監控\n原因：${snapshot.saleEnded ? "活動結束" : "商品售罄"}`);
        return;
      }
      const orderCount = product.inferred_order_count + (orderedUnits > 0 ? 1 : 0);
      const orderedTotal = product.inferred_ordered_units + orderedUnits;
      const changeCount = product.change_count + (changed ? 1 : 0);
      const changedUnitsTotal = product.changed_units_total + Math.abs(inventoryDelta);
      const stableCount = changed ? 0 : product.stable_count + 1;
      const nextPollAt = product.final_window_until
        ? Math.min(now + 120_000, product.final_window_until)
        : now + nextPollDelaySeconds(now) * 1000;
      this.sql.exec(`UPDATE products SET inventory=?,estimated_units=?,inferred_order_count=?,inferred_ordered_units=?,
        change_count=?,changed_units_total=?,stable_count=?,terminal_count=?,error_count=0,status='ACTIVE',reason=NULL,next_poll_at=?,last_success_at=?,updated_at=? WHERE id=?`,
        snapshot.inventory, Math.max(0, -snapshot.inventory), orderCount, orderedTotal, changeCount, changedUnitsTotal, stableCount, terminalCount,
        nextPollAt, now, now, product.id,
      );
      this.insertPollLog(product.id, "SUCCESS", product.inventory, snapshot.inventory, inventoryDelta, snapshot.soldOut, snapshot.saleEnded, null, now, nextPollAt);
      if (changed) this.createEvent(product, snapshot.inventory, inventoryDelta, orderedUnits, adjustmentUnits, changeCount, changedUnitsTotal, now);
    } catch (error) {
      this.handlePollError(product, error);
    }
  }

  private createEvent(product: ProductRow, current: number, delta: number, ordered: number, adjustment: number, changeCount: number, changedUnitsTotal: number, now: number): void {
    const eventId = `${product.id}:${changeCount}:${now}`;
    const type = ordered > 0 ? "ORDER_INFERRED" : "CANCEL_OR_ADJUSTMENT";
    this.sql.exec(`INSERT OR IGNORE INTO order_events
      (id,product_id,sequence_number,previous_inventory,current_inventory,inventory_delta,inferred_order_units,event_type,observed_at)
      VALUES(?,?,?,?,?,?,?,?,?)`, eventId, product.id, changeCount, product.inventory, current, delta, ordered, type, now);
    const average = changeCount ? changedUnitsTotal / changeCount : null;
    const detail = ordered > 0
      ? `**${changeCount}.** 目前數量：\`${current}\`｜與前次相比：**${signed(delta)}**｜本次減少：**${ordered} 本**`
      : `**${changeCount}.** 目前數量：\`${current}\`｜與前次相比：**${signed(delta)}**｜本次增加：**${adjustment} 本**`;
    const content = [`📊 **${product.title}**（\`${product.id}\`）`, detail,
      `推定累計：**${Math.max(0, -current)} 本**`, `數量變更：**${changeCount} 次**｜平均每次變更：**${average == null ? "N/A" : `${average.toFixed(2)} 本`}**`].join("\n");
    for (const subscription of this.sql.exec<{ channel_id: string }>("SELECT channel_id FROM subscriptions WHERE product_id=?", product.id)) {
      this.sql.exec(`INSERT OR IGNORE INTO notification_outbox(id,event_id,channel_id,content,created_at) VALUES(?,?,?,?,?)`,
        crypto.randomUUID(), eventId, subscription.channel_id, content, now);
    }
  }

  private handlePollError(product: ProductRow, error: unknown): void {
    const now = Date.now();
    const reason = error instanceof MonitorError ? error.reason as StopReason : "NETWORK_ERROR";
    const count = product.error_count + 1;
    if (product.final_window_until && product.final_window_until > now) {
      const nextPollAt = Math.min(now + 120_000, product.final_window_until);
      this.sql.exec("UPDATE products SET status='ACTIVE',reason=?,error_count=?,next_poll_at=?,auto_resume_at=NULL,updated_at=? WHERE id=?", reason, count, nextPollAt, now, product.id);
      this.insertPollLog(product.id, "ERROR", product.inventory, null, null, null, null, reason, now, nextPollAt);
      return;
    }
    if (reason === "ACCESS_DENIED") {
      this.sql.exec("UPDATE products SET status='PAUSED',reason=?,auto_resume_at=NULL,error_count=?,updated_at=? WHERE id=?", reason, count, now, product.id);
      this.insertPollLog(product.id, "ERROR", product.inventory, null, null, null, null, reason, now, null);
      return;
    }
    if (reason === "RATE_LIMITED") {
      const backoff = Math.min(3_600_000, 300_000 * 3 ** Math.min(count - 1, 2));
      this.sql.exec("UPDATE products SET status='PAUSED',reason=?,auto_resume_at=?,error_count=?,updated_at=? WHERE id=?", reason, now + backoff, count, now, product.id);
      this.insertPollLog(product.id, "ERROR", product.inventory, null, null, null, null, reason, now, now + backoff);
      return;
    }
    if (reason === "PRODUCT_REMOVED" && count >= 3) {
      this.terminate(product.id, "PRODUCT_REMOVED");
      this.insertPollLog(product.id, "TERMINATED", product.inventory, null, null, null, null, reason, now, null);
      return;
    }
    if (count >= 3) {
      this.sql.exec("UPDATE products SET status='PAUSED',reason=?,auto_resume_at=?,error_count=?,updated_at=? WHERE id=?", reason, now + 900_000, count, now, product.id);
      this.insertPollLog(product.id, "ERROR", product.inventory, null, null, null, null, reason, now, now + 900_000);
    } else {
      this.sql.exec("UPDATE products SET reason=?,error_count=?,next_poll_at=?,updated_at=? WHERE id=?", reason, count, now + 120_000, now, product.id);
      this.insertPollLog(product.id, "ERROR", product.inventory, null, null, null, null, reason, now, now + 120_000);
    }
  }

  private insertPollLog(productId: string, outcome: string, previous: number | null, current: number | null, delta: number | null,
    soldOut: boolean | null, saleEnded: boolean | null, reason: string | null, observedAt: number, nextPollAt: number | null): void {
    this.sql.exec(`INSERT INTO poll_logs
      (id,product_id,outcome,previous_inventory,current_inventory,inventory_delta,sold_out,sale_ended,reason,observed_at,next_poll_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, crypto.randomUUID(), productId, outcome, previous, current, delta,
      soldOut == null ? null : Number(soldOut), saleEnded == null ? null : Number(saleEnded), reason, observedAt, nextPollAt);
  }

  private terminate(id: string, reason: StopReason): void {
    const now = Date.now();
    this.sql.exec("UPDATE products SET status='TERMINATED',reason=?,auto_resume_at=NULL,final_window_until=NULL,terminated_at=?,updated_at=? WHERE id=?", reason, now, now, id);
  }

  private async queueSystemNotice(productId: string, content: string): Promise<void> {
    const eventId = `${productId}:termination:${Date.now()}`;
    for (const subscription of this.sql.exec<{ channel_id: string }>("SELECT channel_id FROM subscriptions WHERE product_id=?", productId)) {
      this.sql.exec("INSERT OR IGNORE INTO notification_outbox(id,event_id,channel_id,content,created_at) VALUES(?,?,?,?,?)", crypto.randomUUID(), eventId, subscription.channel_id, content, Date.now());
    }
  }

  private async flushOutbox(): Promise<void> {
    if (!this.env.DISCORD_BOT_TOKEN) return;
    const pending = [...this.sql.exec<{ id: string; channel_id: string; content: string; attempts: number }>(
      "SELECT id,channel_id,content,attempts FROM notification_outbox WHERE delivered_at IS NULL AND attempts<5 ORDER BY created_at LIMIT 25",
    )];
    for (let index = 0; index < pending.length; index += 5) {
      await Promise.all(pending.slice(index, index + 5).map(async (item) => {
        const response = await fetch(`https://discord.com/api/v10/channels/${item.channel_id}/messages`, {
          method: "POST", headers: { authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ content: item.content, allowed_mentions: { parse: [] } }),
        });
        if (response.ok) this.sql.exec("UPDATE notification_outbox SET delivered_at=? WHERE id=?", Date.now(), item.id);
        else this.sql.exec("UPDATE notification_outbox SET attempts=attempts+1 WHERE id=?", item.id);
      }));
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    const row = [...this.sql.exec<{ due: number | null }>(`SELECT MIN(due) AS due FROM (
      SELECT next_poll_at AS due FROM products WHERE status='ACTIVE'
      UNION ALL SELECT auto_resume_at AS due FROM products WHERE status='PAUSED' AND auto_resume_at IS NOT NULL
      UNION ALL SELECT final_window_until AS due FROM products WHERE status='ACTIVE' AND final_window_until IS NOT NULL
    )`)][0];
    if (row?.due) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1_000, row.due));
    else await this.ctx.storage.deleteAlarm();
  }

  private async discordCommand(payload: unknown): Promise<{ content: string }> {
    const interaction = payload as { guild_id?: string; channel_id?: string; member?: { permissions?: string; user?: { id?: string } }; data?: { options?: Array<{ name: string; options?: Array<{ name: string; value: string | boolean }> }> } };
    const sub = interaction.data?.options?.[0];
    const options = Object.fromEntries((sub?.options || []).map((option) => [option.name, option.value]));
    if (["subscribe", "unsubscribe"].includes(sub?.name || "") && !hasManageChannels(interaction.member?.permissions)) {
      return { content: "❌ 需要「管理頻道」權限才能新增或停止訂閱。" };
    }
    if (sub?.name === "subscribe") {
      const product = await this.addProduct({ url: options.url, name: options.name, authorizationConfirmed: options.authorized === true, channelId: interaction.channel_id, guildId: interaction.guild_id, userId: interaction.member?.user?.id });
      return { content: `✅ 已訂閱 **${product.title}**（\`${product.id}\`）\n基準庫存：\`${product.inventory}\`，基準不計為訂單。` };
    }
    if (sub?.name === "list" || sub?.name === "status") {
      const products = this.listProducts() as Array<Record<string, unknown>>;
      return { content: products.length ? products.map((p) => `• \`${p.id}\` **${p.title}**｜${p.status}｜推定 ${p.estimated_units} 本｜變更 ${p.change_count} 次`).join("\n") : "目前沒有監控商品。" };
    }
    if (sub?.name === "unsubscribe") {
      const id = String(options.product || "");
      this.sql.exec("DELETE FROM subscriptions WHERE product_id=? AND channel_id=?", id, interaction.channel_id || "");
      return { content: `🛑 已停止此頻道對 \`${id}\` 的通知；商品監控仍可在 Portal 管理。` };
    }
    return { content: "不支援的 Cuthoo 指令。" };
  }
}

function signed(value: number): string { return value > 0 ? `+${value}` : String(value); }
function hasManageChannels(permissions?: string): boolean {
  try { return (BigInt(permissions || "0") & 16n) === 16n; } catch { return false; }
}
