# Cuthoo

Cuthoo 是 Cloudflare-native 的簽售商品監控 Portal。它使用 Worker、Durable Object SQLite 與 Alarm，不需要常駐電腦；Discord 是可選通知與 slash-command 入口。

> K-MONSTAR 現行服務條款禁止蜘蛛、爬行或抓取。部署者必須先取得網站對自動監控及頻率的允許。Cuthoo 會要求使用者確認授權，且不提供換 IP、繞過 403/429 或其他規避機制。

## 功能

- 每個商品獨立記錄庫存、推定本數、變化事件、推定訂單與平均每單。
- Portal 支援新增、暫停、恢復與終止。
- Discord `/cuthoo` slash commands 為選配。
- 商品下架、售罄或活動結束連續確認三次後自動終止並保留最終統計。
- `403` 立即暫停；`429` 以 5 分鐘、15 分鐘、1 小時退避，不會更換 IP。
- 預設 60 秒並加 ±20% jitter；近期變化時暫時加速至約 20 秒，長期穩定則降到約 120 秒。
- 使用 outbox 保存 Discord 通知，避免通知失敗時丟失事件。

## 本機開發

```bash
cp .dev.vars.example .dev.vars
npm install
npm run dev
```

開啟 `http://localhost:8787`。本機管理金鑰填在 `.dev.vars` 的 `ADMIN_TOKEN`。

## Cloudflare Secrets

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put DISCORD_APPLICATION_ID
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
```

不使用 Discord 時，Discord secrets 可以留空；Portal 和監控核心仍可運作。

## Discord 設定

```bash
npm run commands:register
```

將部署後的 URL 設為 Discord Interactions Endpoint：

```text
https://<your-worker>/discord/interactions
```

指令：

```text
/cuthoo subscribe url:<網址> authorized:true name:<選填>
/cuthoo list
/cuthoo status
/cuthoo unsubscribe product:<商品 ID>
```

新增與停止訂閱需要使用者具有 Discord「管理頻道」權限。

## 驗證與部署

```bash
npm run typecheck
npm test
npx wrangler deploy --dry-run
npm run deploy
```

部署前請把 `wrangler.jsonc` 的 Worker 名稱改成你 Cloudflare 帳號內可用的唯一名稱。

## 舊版程式

`src/` 保留早期本機 Node.js 原型供計算測試參考，但正式入口已改為 `worker/index.ts`，不再需要 Discord.js、PM2、Webhook或本機 JSON 作為正式資料來源。
