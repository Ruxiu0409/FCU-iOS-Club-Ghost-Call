# FCU iOS Club 茶會演講互動連線

台下所有人的手機同時從「請看台上」切換成一通假來電。接了播錄音，掛了什麼都沒有。

跑在 Cloudflare Workers + Durable Objects 上，**免費方案就能撐 400 人同時在線**。

```
輸入暱稱加入  ──►  請看台上  ──►  [主持人按下 Trigger]  ──►  來電畫面
      ↑                                                   ↙          ↘
  音訊解鎖在這一步                                   接聽→播錄音      拒接→黑畫面
```

---

## 為什麼一定要先輸入暱稱才能進場

那個「加入」按鈕不只是收集名單，**它同時是 iOS 的音訊解鎖手勢**。

iOS Safari 只有在使用者手勢裡播放過的 `<audio>` 元素，之後才能用程式碼觸發播放。
鈴聲是被 WebSocket 訊息觸發的，不是使用者點的，少了進場這一下 tap，
主持人按 Trigger 時全場的鈴聲一定不會響。

相關的三個細節：

1. 兩個 `<audio>` 的 `play()` 必須在同一個手勢事件裡**同步**發出。
   先 `await` 第一個再呼叫第二個，iOS 會判定已經脫離使用者手勢而擋掉。
2. 進場時設 `navigator.audioSession.type = "playback"`（目前只有 Safari 實作），
   把音訊 session 從 ambient 換成 playback，這樣**實體靜音鍵開著也還是會出聲**。
3. iOS 上 `<audio>` 標籤在靜音鍵開著時會出聲，但 Web Audio 不會 —— 所以鈴聲和
   錄音都走 `<audio>` 元素，不用 Web Audio 合成。

---

## 跑起來

```bash
npm install
echo "ADMIN_TOKEN=隨便一組長一點的字串" > .dev.vars
npm run dev
```

- 觀眾：`/`（可加 `?room=xxx` 分場）
- 控制台：`/admin`（Cloudflare 靜態資源會把 `/admin.html` 轉到這裡）

部署：

```bash
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

---

## 換成你自己的內容

| 要換什麼 | 怎麼換 |
|---|---|
| 錄音 | 放成 `public/recording.mp3`，會自動取代預設的佔位音 |
| 來電者名稱、頭像 | `public/index.html` 最上面的 `CONFIG` |
| 鈴聲 | 覆蓋 `public/ringtone.wav` |

內建鈴聲是 `scripts/gen-audio.mjs` 合成的**馬林巴音色原創旋律**，
不是任何手機廠商鈴聲的複製品。想換成別的直接覆蓋檔案即可。
改了產生器記得跑 `npm run gen:audio` 重新產生（CI 會驗這兩者一不一致）。

---

## 事後名單

控制台的「下載名單 CSV」會匯出一人一列、每輪來電各一欄：

| 暱稱 | 加入時間 | 第1輪 | 第2輪 |
|---|---|---|---|
| 小明 | 2026-09-11 19:42:03 | 接聽 | 沒反應 |
| 阿美 | 2026-09-11 19:42:11 | 拒接 | 接聽 |

每個人的身分存在 localStorage 的 device id，所以**斷線重連回來還是同一個人**，
不會被算成兩個。CSV 有 BOM，Excel 開中文不會亂碼。

控制台畫面上只顯示在線人數；接聽／拒接照樣寫進資料庫，只是不即時推送，
省掉「每有一個人回報就送一次全場名單」的開銷。

---

## 測試

```bash
npm run dev          # 另一個視窗

npm run test         # 20 個邊界情境
npm run test:load    # 400 人同時湧入 + 廣播扇出

# 對線上環境跑
HOST=wss://你的.workers.dev ADMIN_TOKEN=xxx npm run test
```

涵蓋的情境包括：遲到進場直接看到來電中、斷線重連接回當前場景、同一裝置重連
不會變成新的人、同一輪重複回報只算第一次、上一輪的回報會被丟掉、重按觸發
不會讓全場再響一遍、錯的 token 連不進來也匯不出 CSV。

### 線上實測（400 條真實連線）

```
DO 身上掛著的 guest 連線數 = 400/400
觸發延遲 ms: min 149 / p50 156 / p95 168 / max 168
在線人數 80 秒不掉：400 → 400 → 400 → 400
```

測試腳本刻意分成兩支，原因很重要：

- `test/ballast.mjs` 負責占住 400 條連線，**一條連上了才連下一條**。
  單一 Node 行程一次發 400 個 TLS handshake 會把自己的網路堆疊塞爆，
  這樣量到的 4 秒延遲是測試機的假象，不是伺服器慢。真實情況是 400 支手機
  各做一次 handshake，不會有這個問題。
- `test/measure.mjs` 只用十幾個觀察者量延遲，避免本機事件迴圈變成瓶頸。

---

## 免費額度夠不夠

一場 400 人、兩小時、觸發 3 次的活動大約用掉：

| 項目 | requests |
|---|---|
| 400 條連線（含重連抓 3 倍） | ~2,400 |
| 觸發廣播（送出的訊息不計費） | ~0 |
| 接聽／拒接回報（20:1 折算） | ~60 |
| 心跳（走 auto-response） | 0 |
| **合計** | **~2,500 / 100,000 每日** |

Duration 約 920 GB-s / 13,000 GB-s。靜態檔案不計次也不計流量。

關鍵在 Durable Objects 的 WebSocket 計費方式：**送出的訊息完全不計費**
（主持人按一下，往 400 支手機廣播是 0 成本），**收到的訊息 20:1 折算**，
WebSocket protocol ping 和 `setWebSocketAutoResponse()` 的心跳都不計費。

順帶一提，其他家免費 realtime 幾乎都卡在 100–200 條同時連線
（Pusher sandbox 100、Ably 200、Supabase Realtime 200），400 人直接爆。

---

## CI / CD

push 到 `main` 會自動跑測試並部署。測試用 miniflare 在本機跑，
**不需要任何 Cloudflare 憑證**，所以 PR 也測得動；只有 main 的 push 才會部署。

要讓自動部署生效，需要在 repo 設兩個 secret：

1. 到 Cloudflare dashboard → My Profile → API Tokens → Create Token，
   選 **Edit Cloudflare Workers** 範本。
2. 加進 GitHub：

```bash
gh secret set CLOUDFLARE_API_TOKEN      # 貼上剛才產生的 token
gh secret set CLOUDFLARE_ACCOUNT_ID     # wrangler whoami 看得到
```

`ADMIN_TOKEN` 是 Worker 的 secret，用 `wrangler secret put` 設定，
不經過 GitHub Actions。

---

## 現場注意事項

1. **提早 10 分鐘讓大家進場**，把連線尖峰跟觸發時間錯開。
2. 上台前務必**拿一支開著靜音鍵的 iPhone 實測**。這是整套最脆弱的環節，
   模擬測試測不出來。
3. iOS 完全不支援 `navigator.vibrate()`，震動只有 Android 會有 ——
   別把效果押在震動上。
4. 會場網路才是最大風險。斷線重連的退避有加抖動，避免 400 人同時湧回來。
