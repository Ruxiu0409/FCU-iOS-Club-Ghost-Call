const HOST = process.env.HOST || "ws://127.0.0.1:8788";   // 例：wss://ghost-call.xxx.workers.dev
const TOKEN = process.env.ADMIN_TOKEN || "devtoken123";
const HTTP = HOST.replace(/^ws/, "http");
const ROOM = "edge" + Date.now();                          // 全新房間，rev 從 0 開始
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}` +
    (ok ? "" : `\n        got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

function open(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const o = { ws, states: [], stats: null, joined: null };
    ws.onopen = () => res(o);
    ws.onerror = () => rej(new Error("connect failed"));
    ws.onmessage = (e) => {
      if (e.data === "P") return;
      const m = JSON.parse(e.data);
      if (m.type === "state") o.states.push({ scene: m.scene, rev: m.rev });
      if (m.type === "joined") o.joined = m.name;
      if (m.stats) o.stats = m.stats;
    };
    o.join = (id, name) => ws.send(JSON.stringify({ type: "join", id, name }));
    o.pick = (choice, rev) => ws.send(JSON.stringify({ type: "choice", choice, rev }));
    return o;
  });
}
const guest = () => open(`${HOST}/ws?room=${ROOM}`);
const admin = () => open(`${HOST}/ws?role=admin&room=${ROOM}&token=${TOKEN}`);

// --- 權限 ---
let rejected = false;
try { await open(`${HOST}/ws?role=admin&room=${ROOM}&token=wrong`); } catch { rejected = true; }
check("錯的 admin token 連不進來", rejected, true);
check("錯的 token 匯不出 CSV",
  (await fetch(`${HTTP}/export?room=${ROOM}&token=wrong`)).status, 401);

const a = await admin();
await sleep(300);

// --- 報名字才算人頭 ---
const g1 = await guest();
await sleep(300);
check("一進場就拿到當前場景", g1.states.at(-1), { scene: "stage", rev: 0 });
check("還沒報暱稱不算在線", a.stats.online, 0);

g1.join("dev-1", "小明");
await sleep(400);
check("報了暱稱才算在線", a.stats.online, 1);
check("伺服器確認收到暱稱", g1.joined, "小明");

// --- 觸發 ---
a.ws.send(JSON.stringify({ type: "scene", scene: "ringing", fromRev: 0 }));
await sleep(400);
check("觸發後收到來電", g1.states.at(-1), { scene: "ringing", rev: 1 });

// --- 遲到的人 ---
const late = await guest();
late.join("dev-2", "阿美");
await sleep(400);
check("遲到進場直接看到來電中", late.states.at(-1), { scene: "ringing", rev: 1 });
check("兩個人都在線", a.stats.online, 2);

// --- 回報 ---
g1.pick("answer", 0);                      // 舊的一輪
await sleep(200);
g1.pick("answer", 1);
await sleep(150);
g1.pick("decline", 1);                     // 同一輪第二次，應該被忽略
late.pick("decline", 1);
await sleep(400);

// --- 同一支裝置重連，不應該變成兩個人 ---
g1.ws.close();
await sleep(500);
check("有人離線後人數會掉", a.stats.online, 1);
const again = await guest();
again.join("dev-1", "小明");                // 同一個 device id
await sleep(400);
check("同一裝置重連不會變成新的人", a.stats.online, 2);
check("重連後接回當前場景", again.states.at(-1), { scene: "ringing", rev: 1 });

// --- 重按觸發 ---
const before = late.states.length;
a.ws.send(JSON.stringify({ type: "scene", scene: "ringing", fromRev: 1 }));
await sleep(400);
check("重按觸發不會讓全場再響一次", late.states.length, before);

// --- 收回 ---
a.ws.send(JSON.stringify({ type: "scene", scene: "stage", fromRev: 1 }));
await sleep(400);
check("收回後回到看台上", late.states.at(-1), { scene: "stage", rev: 2 });

// --- CSV ---
const res = await fetch(`${HTTP}/export?room=${ROOM}&token=${TOKEN}`);
// 注意：Response.text() 解碼時會吃掉 BOM，所以要驗原始位元組
const bytes = new Uint8Array(await res.clone().arrayBuffer());
const csv = await res.text();
const rows = csv.replace(/^﻿/, "").trim().split("\r\n").map((l) =>
  l.slice(1, -1).split('","')
);
check("CSV 有 BOM（Excel 開中文不亂碼）", [...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF]);
check("CSV 標題列", [rows[0][0], rows[0][1], rows[0][2]], ["暱稱", "加入時間", "第1輪"]);
check("CSV 兩個人各一列", rows.length - 1, 2);
check("小明那列：接聽（第一次的選擇，不是後來改的拒接）",
  [rows[1][0], rows[1][2]], ["小明", "接聽"]);
check("阿美那列：拒接", [rows[2][0], rows[2][2]], ["阿美", "拒接"]);
check("加入時間是台北時間格式",
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rows[1][1]), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
