// 恒生強積金智選計劃：最新數據抓取 ＋ 長線趨勢分析 ＋ 自動提醒（已修復積金局合併儲存格解析）
import fs from 'node:fs';

const HS_PAGES = process.env.HS_URL ? [process.env.HS_URL] : [
  'https://www.hangseng.com/en-hk/personal/insurance-mpf/e-mpf/fund-price-performance/',
  'https://www.hangseng.com/e-services/e-mpf/fund-price-performance',
];
const MPFA_LIST = process.env.MPFA_URL || 'https://www.mpfa.org.hk/en/info-centre/fund-information/monthly-fund-price/monthly-unit-prices-of-mpf-constituent-funds';
const MPFA_FILE = (mon, yy) => `https://www.mpfa.org.hk/en/-/media/files/information-centre/fund-information/monthly-fund-price/consolidated_list_for_${mon}_${yy}_read_only.xls`;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const SCHEME = /hang\s*seng\s*mandatory\s*provident\s*fund/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const backfill = process.argv[2] === 'backfill';

fs.mkdirSync('data', { recursive: true });
fs.mkdirSync('debug', { recursive: true });

function readCsv(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const head = lines.shift().split(',');
  return lines.map(l => {
    const c = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(x => x.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
    return Object.fromEntries(head.map((h, i) => [h, c[i]]));
  });
}
const q = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
function writeCsv(file, head, rows) {
  const text = [head.join(','), ...rows.map(r => head.map(h => q(r[h] ?? '')).join(','))].join('\n') + '\n';
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (text !== old) { fs.writeFileSync(file, text); return true; }
  return false;
}
const cleanName = s => String(s || '').replace(/\s+/g, ' ').replace(/[\^*#†]+/g, '').replace(/\s*\(note.*?\)\s*/gi, ' ').trim();
const num = s => { const m = String(s ?? '').replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? +m[0] : NaN; };
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parseDate(t) {
  t = String(t || '');
  let m = t.match(/(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})/i);
  if (m) return `${m[3]}-${String(MON[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = t.match(/(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

async function scrapeHangSeng() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
  });
  const context = await browser.newContext({
    userAgent: UA,
    locale: 'en-HK',
    timezoneId: 'Asia/Hong_Kong',
    viewport: { width: 1366, height: 900 }
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  let result = null, lastErr = '';
  for (const url of HS_PAGES) {
    try {
      console.log('  打開 ' + url);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(5000);
      await page.waitForFunction(() => [...document.querySelectorAll('table tr')]
        .some(tr => /\b\d{1,4}\.\d{2,4}\b/.test(tr.innerText) && /fund/i.test(tr.innerText)), null, { timeout: 60000 });

      const data = await page.evaluate(() => {
        const rows = [];
        document.querySelectorAll('table').forEach(t => {
          const headText = (t.querySelector('thead') || t.rows[0] || {}).innerText || '';
          if (!/bid|offer|price|nav/i.test(headText + ' ' + (t.caption ? t.caption.innerText : ''))) return;
          [...t.querySelectorAll('tr')].forEach(tr => {
            const cells = [...tr.querySelectorAll('th,td')].map(c => c.innerText.trim());
            const nums = cells.slice(1).filter(c => /^\$?\s*\d{1,4}(\.\d+)?$/.test(c.replace(/,/g, '')));
            if (cells.length >= 2 && nums.length && /[a-z]/i.test(cells[0])) rows.push({ name: cells[0], nums });
          });
        });
        const body = document.body.innerText;
        const m = body.match(/(unit\s*price[s]?\s*(as\s*at|as\s*of)?|valuation\s*date|dealing\s*date)[^\n]{0,45}/i);
        return { rows, dateText: m ? m[0] : '' };
      });
      if (data.rows.length) { result = data; break; }
      lastErr = '頁面未渲染價格表';
    } catch (e) {
      lastErr = e.message.split('\n')[0];
      console.log('  ⚠ ' + lastErr);
    }
  }
  await browser.close();

  if (!result) throw new Error(lastErr || '讀取恒生網頁失敗');
  let date = parseDate(result.dateText);
  if (!date) {
    const hk = new Date(Date.now() + 8 * 3600e3);
    date = hk.toISOString().slice(0, 10);
  }

  const out = [];
  const seen = new Set();
  result.rows.forEach(r => {
    const fund = cleanName(r.name);
    const bid = num(r.nums[0]), offer = num(r.nums[1] ?? r.nums[0]);
    if (!fund || !(bid > 0) || seen.has(fund)) return;
    seen.add(fund);
    out.push({ date, fund, bid: bid.toFixed(4), offer: (offer > 0 ? offer : bid).toFixed(4) });
  });
  console.log(`  ✔ 恒生網頁：成功取得 ${out.length} 隻基金，價格日期 ${date}`);
  return out;
}

async function fetchBuf(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2000 || buf.slice(0, 200).toString().toLowerCase().includes('<html')) throw new Error('非 Excel 檔案');
  return buf;
}
function lastDay(y, m) { return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }

// 修復：正確處理積金局 Excel 合併儲存格（往下連續讀取所有恒生基金，直到出現其他受託人計劃名稱）
function parseMpfaXls(buf, fallbackDate) {
  const XLSX = globalThis.__XLSX;
  const wb = XLSX.read(buf, { type: 'buffer' });
  const out = [];
  for (const sn of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: false, defval: '' });
    let date = '';
    for (const r of rows.slice(0, 15)) { const d = parseDate(r.join(' ')); if (d) { date = d; break; } }

    let inHS = false;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].map(c => String(c || '').trim());
      const fullLine = r.join(' ');
      if (!fullLine.trim()) continue;

      // 偵測是否進入恒生強積金計劃區塊
      if (SCHEME.test(fullLine)) {
        inHS = true;
      } else if (inHS) {
        // 如果第一欄（計劃名稱欄）出現新的其他計劃名稱（含 Scheme / Plan / Trust / MPF / Provident），代表已離開恒生區塊
        const firstCol = r[0] || '';
        if (firstCol.length > 5 && !/fund/i.test(firstCol) && /scheme|plan|trust|provident|mpf|aia|manulife|hsbc|sun\s*life|bct|boc|principal|fidelity|schroder|bea/i.test(firstCol)) {
          inHS = false;
          continue;
        }
      }

      if (!inHS) continue;

      // 在這一行尋找基金名稱與單位價格
      const fundCell = r.find(c => /fund/i.test(c) && !SCHEME.test(c));
      const numCells = r.map(c => c.replace(/,/g, '')).filter(c => /^\d{1,4}\.\d{2,}$/.test(c));
      const price = numCells.length ? +numCells[numCells.length - 1] : NaN;

      if (fundCell && price > 0 && price < 10000) {
        const fund = cleanName(fundCell.replace(SCHEME, '').replace(/^[\s\-–—]*(supertrust plus)?[\s\-–—]*/i, ''));
        if (fund && !/constituent\s*fund/i.test(fund)) {
          out.push({ date: date || fallbackDate, fund, price: price.toFixed(4) });
        }
      }
    }
  }
  const map = new Map(); out.forEach(r => map.set(r.fund, r));
  return [...map.values()];
}

async function monthlyUpdate() {
  try { globalThis.__XLSX = (await import('xlsx')).default; } catch (e) { return []; }
  const urls = new Map();
  try {
    const html = await (await fetch(MPFA_LIST, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) })).text();
    for (const m of html.matchAll(/href="([^"]*consolidated_list_for_([a-z]{3})_(\d{2})[^"]*\.xlsx?)"/gi)) {
      const u = new URL(m[1].replace(/&amp;/g, '&'), MPFA_LIST).href;
      urls.set(u, lastDay(2000 + +m[3], MON[m[2].toLowerCase()]));
    }
  } catch (e) {}

  if (backfill) {
    const now = new Date();
    for (let k = 1; k <= 120; k++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
      const u = MPFA_FILE(MONTHS[d.getUTCMonth()], String(d.getUTCFullYear()).slice(2));
      if (![...urls.keys()].some(x => x.toLowerCase() === u.toLowerCase())) urls.set(u, lastDay(d.getUTCFullYear(), d.getUTCMonth() + 1));
    }
  }

  // 統計每個月目前已抓到幾隻基金，若少於 10 隻代表之前漏抓，強制重新補抓
  const monthCounts = new Map();
  readCsv('data/monthly.csv').forEach(r => monthCounts.set(r.date, (monthCounts.get(r.date) || 0) + 1));

  const out = [];
  let miss = 0;
  for (const [u, d] of [...urls].sort((a, b) => a[1] < b[1] ? 1 : -1)) {
    if ((monthCounts.get(d) || 0) >= 10 && !backfill) continue;
    try {
      const rows = parseMpfaXls(await fetchBuf(u), d);
      if (!rows.length) continue;
      out.push(...rows); miss = 0;
      console.log(`  ✔ 積金局 ${d}：${rows.length} 隻基金`);
    } catch (e) {
      if (++miss >= 6 && backfill) break;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return out;
}

const keyOf = name => String(name).toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '');
const DAY = 86400000;
const toT = d => Date.parse(d + 'T00:00:00Z');
const isEquity = name => /equity|index|north america|europe|asia|chinese|china|hang seng/i.test(name) && !/bond|conservative|guaranteed|balanced|stable|growth|age 65|core|retirement/i.test(name);

function runAnalysis(dailyRows, monthlyRows) {
  const map = new Map();
  const add = (name, d, v, isDaily) => {
    if (!d || !(v > 0)) return;
    const k = keyOf(name);
    if (!map.has(k)) map.set(k, { key: k, name, pts: new Map() });
    const f = map.get(k);
    if (isDaily) f.name = name;
    if (isDaily || !f.pts.has(d)) f.pts.set(d, { d, t: toT(d), v });
  };
  monthlyRows.forEach(r => add(r.fund, r.date, +r.price, false));
  dailyRows.forEach(r => add(r.fund, r.date, +r.bid, true));

  const results = [];
  for (const f of map.values()) {
    const pts = [...f.pts.values()].sort((a, b) => a.t - b.t);
    if (pts.length < 8) continue;
    const last = pts[pts.length - 1];

    const smaVals = [];
    for (let m = 0; m < 10; m++) {
      const cut = last.t - m * 30.4375 * DAY;
      let best = null;
      for (const p of pts) { if (p.t <= cut) best = p; else break; }
      if (best) smaVals.push(best.v);
    }
    if (smaVals.length < 8) continue;
    const sma10m = smaVals.reduce((a, b) => a + b, 0) / smaVals.length;
    const dev = last.v / sma10m - 1;

    let base6m = null;
    for (const p of pts) { if (p.t <= last.t - 182 * DAY) base6m = p; else break; }
    const mom6 = base6m ? (last.v / base6m.v - 1) : null;

    let state = 'WARN';
    if (dev >= 0.02) state = 'BULL';
    else if (dev <= -0.02) state = 'BEAR';

    results.push({
      key: f.key,
      name: f.name,
      date: last.d,
      price: last.v,
      sma10m: +sma10m.toFixed(4),
      dev: +(dev * 100).toFixed(2),
      mom6: mom6 != null ? +(mom6 * 100).toFixed(2) : null,
      state,
      isEquity: isEquity(f.name)
    });
  }
  return results;
}

async function sendTelegram(text) {
  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
    if (res.ok) console.log('  ✔ 已發送 Telegram 提醒');
  } catch (e) {}
}

console.log('▶ 1. 抓取最新每日價格（恒生網頁）');
try {
  const today = await scrapeHangSeng();
  const rows = readCsv('data/daily.csv');
  const key = r => r.date + '|' + r.fund;
  const map = new Map(rows.map(r => [key(r), r]));
  let added = 0;
  today.forEach(r => { if (!map.has(key(r))) added++; map.set(key(r), r); });
  const all = [...map.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.fund < b.fund ? -1 : 1);
  writeCsv('data/daily.csv', ['date', 'fund', 'bid', 'offer'], all);
  console.log(`  每日資料：新加入 ${added} 行，總計 ${all.length} 行`);
} catch (e) {
  console.log('✘ 恒生網頁讀取失敗：' + e.message);
}

console.log('▶ 2. 檢查積金局每月價格表');
const monthly = await monthlyUpdate();
if (monthly.length) {
  const rows = readCsv('data/monthly.csv');
  const key = r => r.date + '|' + r.fund;
  const map = new Map(rows.map(r => [key(r), r]));
  monthly.forEach(r => map.set(key(r), r));
  const all = [...map.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.fund < b.fund ? -1 : 1);
  writeCsv('data/monthly.csv', ['date', 'fund', 'price'], all);
}

console.log('▶ 3. 執行長線牛熊趨勢與雙動能分析');
const analysis = runAnalysis(readCsv('data/daily.csv'), readCsv('data/monthly.csv'));
console.log(`  ✔ 成功完成 ${analysis.length} 隻基金的 10個月均線與 6個月動能分析`);

const prevFile = 'data/signals.json';
const prevData = fs.existsSync(prevFile) ? JSON.parse(fs.readFileSync(prevFile, 'utf8')) : { funds: [] };
const prevMap = new Map((prevData.funds || []).map(f => [f.key, f]));

const flips = [];
for (const cur of analysis) {
  if (!cur.isEquity) continue;
  const prev = prevMap.get(cur.key);
  if (prev && prev.state !== cur.state && (cur.state === 'BULL' || cur.state === 'BEAR')) {
    flips.push({ ...cur, oldState: prev.state });
  }
}

const topEquities = analysis
  .filter(f => f.isEquity && f.mom6 !== null)
  .sort((a, b) => b.mom6 - a.mom6)
  .slice(0, 3);

fs.writeFileSync(prevFile, JSON.stringify({ updated: new Date().toISOString(), funds: analysis }, null, 2) + '\n');
fs.writeFileSync('data/status.json', JSON.stringify({ updated: new Date().toISOString(), flipsCount: flips.length }) + '\n');

const latestDate = analysis[0]?.date || new Date().toISOString().slice(0, 10);
let reportLines = [
  `📊 <b>恒生 MPF 長線趨勢報告 (${latestDate})</b>`,
  ``,
  `🏆 <b>6個月動能最強股票基金：</b>`
];
topEquities.forEach((f, idx) => {
  const icon = f.state === 'BULL' ? '🟢' : (f.state === 'BEAR' ? '🔴' : '🟡');
  reportLines.push(`${idx + 1}. ${f.name}: 6月 <b>${f.mom6 > 0 ? '+' : ''}${f.mom6}%</b> | ${icon} 偏離10月線 ${f.dev > 0 ? '+' : ''}${f.dev}%`);
});

if (flips.length > 0) {
  reportLines.push(``, `🚨 <b>重要牛熊轉換警報：</b>`);
  flips.forEach(f => {
    const action = f.state === 'BULL'
      ? `🟢 <b>突破長線牛市 (+2%)</b> → 建議進攻持有`
      : `🔴 <b>跌穿長線熊市 (-2%)</b> → 建議存量轉入保守基金避險`;
    reportLines.push(`• <b>${f.name}</b>: ${action} (現價 ${f.price}, 10月線 ${f.sma10m})`);
  });
  const msg = reportLines.join('\n');
  await sendTelegram(msg);
  fs.writeFileSync('alert_issue.md', msg.replace(/<b>/g, '**').replace(/<\/b>/g, '**'));
} else if (process.env.FORCE_NOTIFY === 'true') {
  await sendTelegram(reportLines.join('\n') + '\n\n✅ 系統運作正常（目前無新變盤訊號）');
}
