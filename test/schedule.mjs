// 直接從 public/index.html 抽出 ringDelay 來驗，測的是真正會出貨的那份程式碼，
// 不是另外抄一份。時鐘算錯會讓某些人永遠不響，而現場看不出來。
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const m = html.match(/function ringDelay\(at, offset, now\) \{[\s\S]*?\n\}/);
if (!m) { console.error("FAIL  抽不到 ringDelay，函式簽名可能被改過"); process.exit(1); }
const ringDelay = new Function(`${m[0]}; return ringDelay;`)();

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n        got ${got} want ${want}`));
  ok ? pass++ : fail++;
};

const NOW = 1_700_000_000_000;
const SRV = NOW;                       // 這一輪伺服器的「現在」

// 時鐘準、對時也成功
check("正常情況：等到約定的時間", ringDelay(SRV + 3000, 0, NOW), 3000);

// 手機慢 5 分鐘，但對時有成功 → offset 會補回來
const slow = NOW - 300_000;
check("手機慢 5 分鐘＋對時成功：照樣等 3 秒",
  ringDelay(SRV + 3000, SRV - slow, slow), 3000);

// 手機快 5 分鐘，對時有成功
const fast = NOW + 300_000;
check("手機快 5 分鐘＋對時成功：照樣等 3 秒",
  ringDelay(SRV + 3000, SRV - fast, fast), 3000);

// 對時失敗（offset 停在 0）而時鐘又不準 —— 這是最危險的組合
check("手機慢 5 分鐘＋對時失敗：立刻響，不是等 5 分鐘",
  ringDelay(SRV + 3000, 0, slow), 0);
check("手機快 5 分鐘＋對時失敗：立刻響",
  ringDelay(SRV + 3000, 0, fast), 0);

// 中途才連進來，約定時間已經過了
check("遲到的人：時間已過就立刻響", ringDelay(SRV - 8000, 0, NOW), 0);

// 邊界
check("剛好 0", ringDelay(SRV, 0, NOW), 0);
check("上限內照等", ringDelay(SRV + 11_999, 0, NOW), 11_999);
check("超過上限視為時鐘壞掉", ringDelay(SRV + 12_001, 0, NOW), 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
