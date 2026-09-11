import { writeFileSync } from 'node:fs';

const SR = 22050;

// 固定種子的亂數：木槌噪音每次產生都一樣，CI 才驗得出音檔有沒有跟著程式更新
let seed = 0x9e3779b9;
function rnd() {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const OUT = new URL('../public/', import.meta.url);

function wav(samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32000), 44 + i * 2);
  }
  return buf;
}

// 馬林巴音色：木琴條的泛音大致落在基頻的 1 : 4 : 10 附近，
// 高次泛音衰減得比基頻快，再加一小段噪音當木槌敲擊的起音。
function marimba(freq, dur) {
  const n = Math.round(dur * SR);
  const out = new Float32Array(n);
  const partials = [
    { r: 1.0, a: 1.00, d: 5.5 },
    { r: 3.9, a: 0.38, d: 11 },
    { r: 9.2, a: 0.13, d: 19 },
  ];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (const p of partials) {
      v += p.a * Math.sin(2 * Math.PI * freq * p.r * t) * Math.exp(-p.d * t);
    }
    v += 0.18 * Math.exp(-140 * t) * (rnd() * 2 - 1);          // 木槌
    out[i] = v * 0.42;
  }
  return out;
}

// 把一串音符混進一段固定長度的緩衝區，好讓整段可以無縫 loop
function mix(events, totalSec) {
  const out = new Float32Array(Math.round(totalSec * SR));
  for (const [at, freq, dur, gain = 1] of events) {
    const note = marimba(freq, dur);
    const off = Math.round(at * SR);
    for (let i = 0; i < note.length && off + i < out.length; i++) {
      out[off + i] += note[i] * gain;
    }
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0.95) for (let i = 0; i < out.length; i++) out[i] *= 0.95 / peak;
  return out;
}

const N = { G5: 783.99, A5: 880.00, C6: 1046.50, D6: 1174.66, E6: 1318.51, G6: 1567.98 };

// 鈴聲：原創旋律，不是任何手機廠商的鈴聲複製品。
// 想換成別的就直接覆蓋 public/ringtone.wav。
// 一響 1.2 秒、停 1.8 秒，整段 3 秒，loop 起來像真的在響。
writeFileSync(new URL('ringtone.wav', OUT), wav(mix([
  [0.00, N.G5, 0.9],
  [0.15, N.C6, 0.9],
  [0.30, N.E6, 0.9],
  [0.45, N.G6, 1.1],
  [0.60, N.E6, 0.9],
  [0.75, N.C6, 0.9],
  [0.90, N.G5, 1.2],
], 3.0)));

// 佔位錄音：讓流程在你放真檔案之前就能完整走一遍。約 9 秒。
const melody = [N.C6, N.E6, N.G6, N.E6, N.D6, N.A5, N.G5, N.C6];
const ev = [];
let t = 0.3;
for (let r = 0; r < 3; r++) {
  for (const f of melody) { ev.push([t, f, 0.7, 0.75]); t += 0.35; }
}
writeFileSync(new URL('placeholder-recording.wav', OUT), wav(mix(ev, t + 0.5)));

console.log('ringtone.wav + placeholder-recording.wav 產生完成');
