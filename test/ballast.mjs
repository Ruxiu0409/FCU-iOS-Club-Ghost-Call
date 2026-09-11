// 占住連線用。重點：一條連上了才連下一條 —— 單一行程同時發 400 個 TLS
// handshake 會把自己的網路堆疊塞爆，那是測試機的限制，不是伺服器的。
const HOST = process.env.HOST || "ws://127.0.0.1:8788";
const ROOM = process.env.ROOM || "main";
const N = Number(process.argv[2] || 100);
const HOLD = Number(process.argv[3] || 90000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let ok = 0, failed = 0;
const errs = new Map();

for (let i = 0; i < N; i++) {
  await new Promise((res) => {
    const ws = new WebSocket(`${HOST}/ws?room=${ROOM}`);
    let done = false;
    const fin = (why) => {
      if (done) return; done = true;
      if (why) { failed++; errs.set(why, (errs.get(why) || 0) + 1); } else ok++;
      res();
    };
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "join", id: `ballast-${i}`, name: `測試${i + 1}` }));
      // 跟正式前端一樣的心跳，走 DO auto-response：不喚醒物件也不計費
      setInterval(() => { if (ws.readyState === 1) ws.send("p"); }, 25000);
      fin(null);
    };
    ws.onclose = (e) => fin(`close ${e.code}`);
    ws.onerror = () => {};
    setTimeout(() => fin("timeout"), 15000);
  });
  await sleep(4);
}

console.log(`ballast ready ${ok}/${N}` + (failed ? ` (失敗 ${failed}: ${[...errs].map(([k,v])=>`${v}x ${k}`).join(", ")})` : ""));
setTimeout(() => process.exit(0), HOLD);
