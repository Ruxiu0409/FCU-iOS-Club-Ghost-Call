const HOST = process.env.HOST || "ws://127.0.0.1:8788";   // 例：wss://ghost-call.xxx.workers.dev
const N = Number(process.argv[2] || 400);
const TOKEN = process.env.ADMIN_TOKEN || "devtoken123";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const guests = [];
let gotRinging = 0, firstRingAt = 0, lastRingAt = 0, fireAt = 0;

function guest(i) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${HOST}/ws?room=test`);
    const g = { ws, i, rev: -1, scene: null, choice: null };
    const to = setTimeout(() => reject(new Error(`guest ${i} connect timeout`)), 20000);
    ws.onopen = () => { clearTimeout(to); guests.push(g); resolve(g); };
    ws.onerror = (e) => { clearTimeout(to); reject(new Error(`guest ${i} error`)); };
    ws.onmessage = (e) => {
      if (e.data === "P") return;
      const m = JSON.parse(e.data);
      if (m.type !== "state") return;
      g.rev = m.rev; g.scene = m.scene;
      if (m.scene === "ringing" && fireAt) {
        gotRinging++;
        const t = Date.now() - fireAt;
        if (!firstRingAt) firstRingAt = t;
        lastRingAt = t;
        // 七成的人會接
        const choice = Math.random() < 0.7 ? "answer" : "decline";
        g.choice = choice;
        setTimeout(() => ws.send(JSON.stringify({ type: "choice", choice, rev: m.rev })),
                   200 + Math.random() * 1500);
      }
    };
  });
}

const admin = await new Promise((resolve, reject) => {
  const ws = new WebSocket(`${HOST}/ws?role=admin&room=test&token=${TOKEN}`);
  let stats = null, state = null;
  ws.onopen = () => resolve({ ws, get stats(){return stats}, get state(){return state} });
  ws.onerror = () => reject(new Error("admin connect failed"));
  ws.onmessage = (e) => {
    if (e.data === "P") return;
    const m = JSON.parse(e.data);
    if (m.type === "state") state = m;
    if (m.stats) stats = m.stats;
  };
});
console.log("admin connected");

// --- 開場尖峰：400 人同時湧入 ---
const SPREAD = Number(process.argv[3] || 0);   // ms，模擬大家不是同一毫秒點進來
const t0 = Date.now();
const settled = await Promise.allSettled(Array.from({ length: N }, async (_, i) => {
  if (SPREAD) await sleep(Math.random() * SPREAD);
  return guest(i);
}));
const ok = settled.filter(s => s.status === "fulfilled").length;
console.log(`connect burst: ${ok}/${N} in ${Date.now() - t0}ms`);
settled.filter(s => s.status === "rejected").slice(0,3).forEach(s => console.log("  !", s.reason.message));

await sleep(1500);
console.log("admin sees online =", admin.stats?.online);

// --- 觸發 ---
fireAt = Date.now();
admin.ws.send(JSON.stringify({ type: "scene", scene: "ringing", fromRev: admin.state.rev }));

// 重複觸發：驗證冪等
await sleep(50);
admin.ws.send(JSON.stringify({ type: "scene", scene: "ringing", fromRev: admin.state.rev }));

await sleep(4000);
console.log(`broadcast fan-out: ${gotRinging}/${ok} 收到，第一個 ${firstRingAt}ms，最後一個 ${lastRingAt}ms`);
console.log("rev after double-fire =", admin.state.rev, "(修好後應該是 1，重按不動作)");

const expectAns = guests.filter(g => g.choice === "answer").length;
const expectDec = guests.filter(g => g.choice === "decline").length;
console.log("admin stats:", admin.stats);
console.log("expected:   ", { online: ok, answered: expectAns, declined: expectDec });

// --- 收回 ---
admin.ws.send(JSON.stringify({ type: "scene", scene: "stage", fromRev: admin.state.rev }));
await sleep(1200);
console.log("reset →", admin.state.scene, "stats:", admin.stats);
const backToStage = guests.filter(g => g.scene === "stage").length;
console.log(`回到看台上的人數: ${backToStage}/${ok}`);

for (const g of guests) g.ws.close();
admin.ws.close();
await sleep(300);
process.exit(0);
