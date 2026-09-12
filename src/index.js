const DEFAULT_STATE = { scene: "stage", rev: 0, at: 0 };
// 認得的場景。不在名單裡的一律當成 stage，主持人打錯字不會讓全場卡住。
const SCENES = new Set(["stage", "ringing", "app"]);
const MAX_DELAY = 10000;
const MAX_NAME = 24;
const BOM = "\uFEFF";

// 去掉控制字元，避免暱稱把 CSV 或畫面弄壞
const clean = (s) =>
  String(s ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, MAX_NAME);

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS people(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      )`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS rounds(
        rev INTEGER PRIMARY KEY,
        started_at INTEGER NOT NULL
      )`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS choices(
        rev INTEGER NOT NULL,
        id TEXT NOT NULL,
        choice TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (rev, id)
      )`);
    });

    // 心跳走 auto-response：不喚醒 hibernate 中的 DO，也不計費
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("p", "P"));
  }

  async getState() {
    return (await this.ctx.storage.get("state")) ?? DEFAULT_STATE;
  }

  rows(q, ...b) {
    return this.sql.exec(q, ...b).toArray();
  }

  // 接聽/拒接照樣寫進 DB 供事後匯出，但不即時推給 admin ——
  // 省掉「每有一個人回報就送一次全場名單」的開銷。
  // ready 是「音檔已經下載完」，在線不等於準備好。
  counts() {
    const online = new Set(), ready = new Set();
    for (const ws of this.ctx.getWebSockets("guest")) {
      if (ws.readyState !== 1) continue;
      let a;
      try { a = ws.deserializeAttachment(); } catch { continue; }
      if (!a?.id || !a?.name) continue;
      online.add(a.id);                      // 同一人開兩個分頁不重複計
      if (a.ready) ready.add(a.id);
    }
    return { online: online.size, ready: ready.size };
  }

  broadcast(payload, tag) {
    const msg = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets(tag)) {
      try { ws.send(msg); } catch {}
    }
  }

  pushAdmin() {
    this.broadcast({ type: "stats", stats: this.counts() }, "admin");
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/export") return this.exportCsv();
    if (url.pathname !== "/ws") return new Response("not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const role = url.searchParams.get("role") === "admin" ? "admin" : "guest";
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, id: null, name: null });

    const state = await this.getState();
    server.send(JSON.stringify({
      type: "state",
      ...state,
      ...(role === "admin" ? { stats: this.counts() } : {}),
    }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const att = ws.deserializeAttachment() ?? {};
    const state = await this.getState();

    // NTP 式對時：客戶端用 RTT 推算自己跟伺服器的時差
    if (msg.type === "sync") {
      ws.send(JSON.stringify({ type: "sync", c: msg.c, s: Date.now() }));
      return;
    }

    if (att.role === "guest") return this.onGuest(ws, att, msg, state);
    if (att.role !== "admin") return;

    if (msg.type === "scene") {
      // 帶著你看到的 rev 來；對不上代表狀態已經被改過了
      if (typeof msg.fromRev === "number" && msg.fromRev !== state.rev) {
        ws.send(JSON.stringify({
          type: "state", ...state, stats: this.counts(),
        }));
        return;
      }
      const scene = SCENES.has(msg.scene) ? msg.scene : "stage";
      // 已經在這個場景就不動作，否則重按會讓全場再響一遍
      if (scene === state.scene) return;

      const delay = scene === "ringing"
        ? Math.min(MAX_DELAY, Math.max(0, Number(msg.delay) || 0))
        : 0;
      const next = { scene, rev: state.rev + 1, at: Date.now() + delay };
      await this.ctx.storage.put("state", next);
      if (scene === "ringing") {
        this.sql.exec(
          `INSERT OR REPLACE INTO rounds(rev, started_at) VALUES(?, ?)`,
          next.rev, Date.now()
        );
      }
      this.broadcast({ type: "state", ...next });
      this.broadcast(
        { type: "state", ...next, stats: this.counts() }, "admin"
      );
      return;
    }

    if (msg.type === "wipe") return this.wipe(ws, state);
    if (msg.type === "refresh") this.pushAdmin();
  }

  // 清空名單與所有回報。不可復原。
  async wipe(ws, state) {
    const removed = Number(this.rows(`SELECT COUNT(*) n FROM people`)[0]?.n ?? 0);
    this.sql.exec(`DELETE FROM choices`);
    this.sql.exec(`DELETE FROM rounds`);
    this.sql.exec(`DELETE FROM people`);

    // 現場還連著的人要重新登記回去，否則「在線人數」算得到他們、
    // 名單卻查無此人，兩邊會對不起來。
    const now = Date.now();
    let kept = 0;
    for (const g of this.ctx.getWebSockets("guest")) {
      if (g.readyState !== 1) continue;
      let at;
      try { at = g.deserializeAttachment(); } catch { continue; }
      if (!at?.id || !at?.name) continue;
      this.sql.exec(
        `INSERT INTO people(id, name, joined_at, last_seen) VALUES(?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`,
        at.id, at.name, now, now
      );
      kept++;
    }

    // 一併收回到看台上。若正響到一半就清掉 rounds，那一輪的回報會被記進
    // 一個 CSV 裡沒有對應欄位的 rev，變成查不到的孤兒資料。
    const next = { scene: "stage", rev: state.rev + 1, at: Date.now() };
    await this.ctx.storage.put("state", next);
    this.broadcast({ type: "state", ...next });
    this.broadcast(
      { type: "state", ...next, stats: this.counts() }, "admin"
    );
    ws.send(JSON.stringify({ type: "wiped", removed, kept }));
  }

  async onGuest(ws, att, msg, state) {
    const now = Date.now();

    if (msg.type === "join") {
      const id = clean(msg.id);
      const name = clean(msg.name);
      if (!id || !name) return;
      this.sql.exec(
        `INSERT INTO people(id, name, joined_at, last_seen) VALUES(?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`,
        id, name, now, now
      );
      ws.serializeAttachment({ ...att, id, name });
      ws.send(JSON.stringify({ type: "joined", name }));
      this.pushAdmin();
      return;
    }

    if (msg.type === "ready") {
      if (!att.id || att.ready) return;
      ws.serializeAttachment({ ...att, ready: true });
      this.pushAdmin();
      return;
    }

    if (msg.type !== "choice" || !att.id) return;
    if (msg.rev !== state.rev) return;                  // 上一輪的回報，丟掉
    if (msg.choice !== "answer" && msg.choice !== "decline") return;
    // 同一輪只記第一次，靠 PRIMARY KEY(rev,id) + DO NOTHING
    this.sql.exec(
      `INSERT INTO choices(rev, id, choice, at) VALUES(?, ?, ?, ?)
       ON CONFLICT(rev, id) DO NOTHING`,
      state.rev, att.id, msg.choice, now
    );
  }

  async webSocketClose(ws) {
    const a = ws.deserializeAttachment() ?? {};
    if (a.role === "guest" && a.id) this.pushAdmin();
  }

  async webSocketError() {
    this.pushAdmin();
  }

  // 事後匯出：一人一列，每一輪來電各一欄
  exportCsv() {
    const revs = this.rows(`SELECT rev FROM rounds ORDER BY rev`).map((r) => Number(r.rev));
    const people = this.rows(`SELECT id, name, joined_at FROM people ORDER BY joined_at`);
    const picks = new Map();
    for (const r of this.rows(`SELECT rev, id, choice FROM choices`)) {
      picks.set(`${r.rev}|${r.id}`, r.choice);
    }
    const label = { answer: "接聽", decline: "拒接" };
    const tw = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Taipei" });
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;

    const head = ["暱稱", "加入時間", ...revs.map((_, i) => `第${i + 1}輪`)];
    const lines = [head.map(q).join(",")];
    for (const p of people) {
      lines.push([
        q(p.name),
        q(tw(Number(p.joined_at))),
        ...revs.map((rev) => q(label[picks.get(`${rev}|${p.id}`)] ?? "沒反應")),
      ].join(","));
    }
    // 前置 BOM，Excel 開中文才不會亂碼
    return new Response(BOM + lines.join("\r\n"), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="ghost-call-${Date.now()}.csv"`,
      },
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isWs = url.pathname === "/ws";
    const isExport = url.pathname === "/export";
    if (!isWs && !isExport) return new Response("not found", { status: 404 });

    // 沒設 ADMIN_TOKEN 就一律擋掉，避免忘了設而全場開放
    const needsAuth = isExport || url.searchParams.get("role") === "admin";
    if (needsAuth) {
      if (!env.ADMIN_TOKEN || url.searchParams.get("token") !== env.ADMIN_TOKEN) {
        return new Response("unauthorized", { status: 401 });
      }
    }

    const room = (url.searchParams.get("room") || "main").slice(0, 64);
    return env.ROOM.get(env.ROOM.idFromName(room)).fetch(request);
  },
};
