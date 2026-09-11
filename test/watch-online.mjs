// 盯著在線人數，看 400 條連線撐不撐得住時間
const HOST = process.env.HOST || "ws://127.0.0.1:8788";
const TOKEN = process.env.ADMIN_TOKEN || "devtoken123";
const ROOM = process.env.ROOM || "main";
const SECS = Number(process.argv[2] || 200);

let stats = null;
const ws = new WebSocket(`${HOST}/ws?role=admin&room=${ROOM}&token=${TOKEN}`);
ws.onmessage = (e) => {
  if (e.data === "P") return;
  const m = JSON.parse(e.data);
  if (m.stats) stats = m.stats;
};
setInterval(() => { if (ws.readyState === 1) ws.send("p"); }, 25000);
// 定期要一次統計，因為沒人進出時 DO 不會主動推
setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "stats" })); }, 5000);

const t0 = Date.now();
const tick = setInterval(() => {
  const s = Math.round((Date.now() - t0) / 1000);
  console.log(`t+${String(s).padStart(3)}s  online=${stats?.online ?? "?"}`);
  if (s >= SECS) { clearInterval(tick); process.exit(0); }
}, 20000);
