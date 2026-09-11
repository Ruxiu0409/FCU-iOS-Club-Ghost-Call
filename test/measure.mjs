// 少量觀察者量真實的廣播延遲，避免本機事件迴圈變成瓶頸
const HOST = process.env.HOST || "ws://127.0.0.1:8788";
const TOKEN = process.env.ADMIN_TOKEN || "devtoken123";
const ROOM = process.env.ROOM || "main";
const OBS = Number(process.argv[2] || 10);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function open(url, onState) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error("connect failed"));
    ws.onmessage = (e) => {
      if (e.data === "P") return;
      const m = JSON.parse(e.data);
      if (m.type === "state" || m.stats) onState(m);
    };
  });
}

let adminState = null, adminStats = null;
const admin = await open(`${HOST}/ws?role=admin&room=${ROOM}&token=${TOKEN}`,
  (m) => { if (m.type === "state") adminState = m; if (m.stats) adminStats = m.stats; });
await sleep(500);
console.log("DO 身上目前掛著的 guest 連線數 =", adminStats?.online);

let fireAt = 0;
const lat = [];
for (let i = 0; i < OBS; i++) {
  const ob = await open(`${HOST}/ws?room=${ROOM}`, (m) => {
    if (m.scene === "ringing" && fireAt) lat.push(Date.now() - fireAt);
  });
  ob.send(JSON.stringify({ type: "join", id: `obs-${i}`, name: `觀察${i + 1}` }));
  await sleep(20);
}
await sleep(800);

// 先確保場景是 stage
if (adminState.scene !== "stage") {
  admin.send(JSON.stringify({ type: "scene", scene: "stage", fromRev: adminState.rev }));
  await sleep(800);
}

fireAt = Date.now();
admin.send(JSON.stringify({ type: "scene", scene: "ringing", fromRev: adminState.rev }));
await sleep(6000);

lat.sort((a, b) => a - b);
const p = (q) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))];
console.log(`觀察者 ${lat.length}/${OBS} 收到來電`);
console.log(`延遲 ms: min ${lat[0]} / p50 ${p(0.5)} / p95 ${p(0.95)} / max ${lat.at(-1)}`);
admin.send(JSON.stringify({ type: "scene", scene: "stage", fromRev: adminState.rev }));
await sleep(500);
process.exit(0);
