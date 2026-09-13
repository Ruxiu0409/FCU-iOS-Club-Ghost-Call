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

// 等條件成立，不要用固定 sleep 賭伺服器多快回來。
// 成立就立刻回傳；逾時則回傳最後一次的值，讓 check 印出真正的狀況。
async function until(get, ok, ms = 5000) {
  const t0 = Date.now();
  let v;
  do {
    v = await get();
    if (ok(v)) return v;
    await sleep(40);
  } while (Date.now() - t0 < ms);
  return v;
}
const eq = (want) => (v) => JSON.stringify(v) === JSON.stringify(want);

function open(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const o = { ws, states: [], stats: null, joined: null, wiped: null };
    ws.onopen = () => res(o);
    ws.onerror = () => rej(new Error("connect failed"));
    ws.onmessage = (e) => {
      if (e.data === "P") return;
      const m = JSON.parse(e.data);
      if (m.type === "state") { o.states.push({ scene: m.scene, rev: m.rev }); o.lastAt = m.at; }
      if (m.type === "sync") o.sync = m;
      if (m.type === "joined") o.joined = m.name;
      if (m.stats) o.stats = m.stats;
      if (m.type === "wiped") o.wiped = m;
    };
    o.join = (id, name) => ws.send(JSON.stringify({ type: "join", id, name }));
    o.pick = (choice, rev) => ws.send(JSON.stringify({ type: "choice", choice, rev }));
    o.ready = () => ws.send(JSON.stringify({ type: "ready" }));
    o.doSync = () => ws.send(JSON.stringify({ type: "sync", c: Date.now() }));
    return o;
  });
}
const guest = () => open(`${HOST}/ws?room=${ROOM}`);
const admin = () => open(`${HOST}/ws?role=admin&room=${ROOM}&token=${TOKEN}`);
const last = (o) => () => o.states.at(-1);
const online = (o) => () => o.stats?.online;
const readyN = (o) => () => o.stats?.ready;

async function csvRows() {
  const res = await fetch(`${HTTP}/export?room=${ROOM}&token=${TOKEN}`);
  const bytes = new Uint8Array(await res.clone().arrayBuffer());
  const text = await res.text();          // 注意：text() 解碼時會吃掉 BOM
  const rows = text.trim().split("\r\n").map((l) => l.slice(1, -1).split('","'));
  return { bytes, rows };
}

// --- 權限 ---
let rejected = false;
try { await open(`${HOST}/ws?role=admin&room=${ROOM}&token=wrong`); } catch { rejected = true; }
check("錯的 admin token 連不進來", rejected, true);
check("錯的 token 匯不出 CSV",
  (await fetch(`${HTTP}/export?room=${ROOM}&token=wrong`)).status, 401);

const a = await admin();
await until(online(a), (v) => v !== undefined);

// --- 報名字才算人頭 ---
const g1 = await guest();
check("一進場就拿到當前場景",
  await until(last(g1), eq({ scene: "stage", rev: 0 })), { scene: "stage", rev: 0 });
await sleep(300);                        // 沒有事件可等，只能給一點時間確認它「不會」變
check("還沒報暱稱不算在線", a.stats.online, 0);

g1.join("dev-1", "小明");
check("報了暱稱才算在線", await until(online(a), eq(1)), 1);
check("伺服器確認收到暱稱", await until(() => g1.joined, eq("小明")), "小明");

// --- 在線不等於準備好 ---
check("剛加入時還沒就緒", a.stats.ready, 0);
g1.ready();
check("回報音檔載完才算就緒", await until(readyN(a), eq(1)), 1);
g1.ready();
await sleep(200);
check("重複回報就緒不會重複計算", a.stats.ready, 1);

// --- 對時 ---
g1.doSync();
const sy = await until(() => g1.sync, (v) => !!v);
check("對時會把送出的時間原樣帶回來", typeof sy.c, "number");
check("對時有帶伺服器時間", Math.abs(sy.s - Date.now()) < 60000, true);

// --- 觸發 ---
a.ws.send(JSON.stringify({ type: "scene", scene: "ringing", fromRev: 0 }));
check("觸發後收到來電",
  await until(last(g1), eq({ scene: "ringing", rev: 1 })), { scene: "ringing", rev: 1 });

// --- 遲到的人 ---
const late = await guest();
late.join("dev-2", "阿美");
check("遲到進場直接看到來電中",
  await until(last(late), eq({ scene: "ringing", rev: 1 })), { scene: "ringing", rev: 1 });
check("兩個人都在線", await until(online(a), eq(2)), 2);

// --- 回報 ---
g1.pick("answer", 0);                      // 舊的一輪，應該被丟掉
await sleep(120);
g1.pick("answer", 1);
await sleep(120);
g1.pick("decline", 1);                     // 同一輪第二次，應該被忽略
late.pick("decline", 1);

// --- 同一支裝置重連，不應該變成兩個人 ---
g1.ws.close();
check("有人離線後人數會掉", await until(online(a), eq(1)), 1);
const again = await guest();
again.join("dev-1", "小明");                // 同一個 device id
check("同一裝置重連不會變成新的人", await until(online(a), eq(2)), 2);
check("重連後接回當前場景",
  await until(last(again), eq({ scene: "ringing", rev: 1 })), { scene: "ringing", rev: 1 });

// --- 重按觸發：這是在驗「不會發生的事」，只能等一段固定時間 ---
const before = late.states.length;
a.ws.send(JSON.stringify({ type: "scene", scene: "ringing", fromRev: 1 }));
await sleep(800);
check("重按觸發不會讓全場再響一次", late.states.length, before);

// --- 收回 ---
a.ws.send(JSON.stringify({ type: "scene", scene: "stage", fromRev: 1 }));
check("收回後回到看台上",
  await until(last(late), eq({ scene: "stage", rev: 2 })), { scene: "stage", rev: 2 });

// --- CSV：等兩個人的選擇都寫進去 ---
const { bytes, rows } = await until(
  csvRows,
  (r) => r.rows.length === 3 && r.rows[1][2] !== "沒反應" && r.rows[2][2] !== "沒反應"
);
check("CSV 有 BOM（Excel 開中文不亂碼）", [...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF]);
check("CSV 標題列", [rows[0][0], rows[0][1], rows[0][2]], ["暱稱", "加入時間", "第1輪"]);
check("CSV 兩個人各一列", rows.length - 1, 2);
check("小明那列：接聽（第一次的選擇，不是後來改的拒接）",
  [rows[1][0], rows[1][2]], ["小明", "接聽"]);
check("阿美那列：拒接", [rows[2][0], rows[2][2]], ["阿美", "拒接"]);
check("加入時間是台北時間格式",
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rows[1][1]), true);

// --- 清除資料：挑「響到一半」這個時機清，這是最容易留下孤兒資料的情況 ---
a.ws.send(JSON.stringify({ type: "scene", scene: "ringing", fromRev: 2 }));
await until(last(late), eq({ scene: "ringing", rev: 3 }));
late.pick("answer", 3);
await sleep(200);

a.ws.send(JSON.stringify({ type: "wipe" }));
const w = await until(() => a.wiped, (v) => !!v);
check("回報刪掉幾筆", w.removed, 2);
check("現場還連著的人重新登記回去", w.kept, 2);
check("清除後把大家收回看台上",
  await until(last(late), eq({ scene: "stage", rev: 4 })), { scene: "stage", rev: 4 });
check("在線人數沒有因為清除而歸零", await until(online(a), eq(2)), 2);

const after = await until(csvRows, (r) => r.rows[0].length === 2);
check("清除後沒有殘留的來電輪次欄位", after.rows[0], ["暱稱", "加入時間"]);
check("清除後名單只剩現場連著的人", after.rows.length - 1, 2);
check("名字還在（不是變成空白列）",
  [after.rows[1][0], after.rows[2][0]].sort(), ["小明", "阿美"].sort());

// --- 預約觸發：約好時間一起響，不是收到就響 ---
const fireRev = late.states.at(-1).rev;
a.ws.send(JSON.stringify({
  type: "scene", scene: "ringing", fromRev: fireRev, delay: 1500,
}));
await until(last(late), (v) => v?.scene === "ringing");
const lead = late.lastAt - Date.now();
check("預約觸發的 at 落在未來", lead > 700 && lead <= 1700, true);

// 重連的人拿到的是同一個 at，不會各響各的
const rejoin = await guest();
rejoin.join("dev-3", "阿華");
await until(last(rejoin), (v) => v?.scene === "ringing");
check("中途進來的人拿到同一個觸發時間", rejoin.lastAt, late.lastAt);

// 不帶 delay 就是立刻
a.ws.send(JSON.stringify({ type: "scene", scene: "stage", fromRev: late.states.at(-1).rev }));
await until(last(late), (v) => v?.scene === "stage");
check("不帶 delay 時 at 就是現在", Math.abs(late.lastAt - Date.now()) < 3000, true);

// --- App 畫面：第三個場景 ---
const appRev = late.states.at(-1).rev + 1;
a.ws.send(JSON.stringify({ type: "scene", scene: "app", fromRev: appRev - 1 }));
check("切到 App 畫面",
  await until(last(late), eq({ scene: "app", rev: appRev })), { scene: "app", rev: appRev });

const g4 = await guest();
g4.join("dev-4", "阿吉");
check("中途進來的人直接看到 App 畫面",
  await until(last(g4), eq({ scene: "app", rev: appRev })), { scene: "app", rev: appRev });

const beforeApp = late.states.length;
a.ws.send(JSON.stringify({ type: "scene", scene: "app", fromRev: appRev }));
await sleep(600);
check("重按不會把已經在 App 畫面的人再推一次", late.states.length, beforeApp);

// --- 新聞頁：第四個場景 ---
const newsRev = appRev + 1;
const colsBeforeNews = (await csvRows()).rows[0].length;
a.ws.send(JSON.stringify({ type: "scene", scene: "news", fromRev: appRev }));
check("切到新聞頁",
  await until(last(late), eq({ scene: "news", rev: newsRev })), { scene: "news", rev: newsRev });
// 新聞頁跟 App 畫面一樣不是一輪來電
check("切到新聞頁不會多記一輪來電", (await csvRows()).rows[0].length, colsBeforeNews);

const g5 = await guest();
g5.join("dev-5", "小柚");
check("中途進來的人直接看到新聞頁",
  await until(last(g5), eq({ scene: "news", rev: newsRev })), { scene: "news", rev: newsRev });

// 主持人打錯字不該讓全場卡在一個沒人認得的場景
a.ws.send(JSON.stringify({ type: "scene", scene: "沒這個場景", fromRev: newsRev }));
check("不認得的場景一律當成請看台上",
  await until(last(late), eq({ scene: "stage", rev: newsRev + 1 })),
  { scene: "stage", rev: newsRev + 1 });

// App 畫面不是一輪來電，不該在 CSV 多長出一欄沒人接的紀錄
const colsBefore = (await csvRows()).rows[0].length;
a.ws.send(JSON.stringify({ type: "scene", scene: "app", fromRev: newsRev + 1 }));
await until(last(late), (v) => v?.scene === "app");
check("切到 App 畫面不會多記一輪來電", (await csvRows()).rows[0].length, colsBefore);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
