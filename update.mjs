// 全港 11 大強積金受託人長線趨勢決策系統：數據抓取 ＋ 轉強轉差預警 ＋ 自動提醒
import fs from 'node:fs';

const HS_PAGES = process.env.HS_URL ? [process.env.HS_URL] : [
  'https://www.hangseng.com/en-hk/personal/insurance-mpf/e-mpf/fund-price-performance/',
  'https://www.hangseng.com/e-services/e-mpf/fund-price-performance',
];
const MPFA_LIST = process.env.MPFA_URL || 'https://www.mpfa.org.hk/en/info-centre/fund-information/monthly-fund-price/monthly-unit-prices-of-mpf-constituent-funds';
const MPFA_FILE = (mon, yy) => `https://www.mpfa.org.hk/en/-/media/files/information-centre/fund-information/monthly-fund-price/consolidated_list_for_${mon}_${yy}_read_only.xls`;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// 全港 11 大主流強積金受託人計劃
const TARGET_SCHEMES = [
  { id: 'hangseng', label: '恒生智選', re: /hang\s*seng\s*mandatory\s*provident\s*fund\s*-\s*supertrust\s*plus/i },
  { id: 'manulife', label: '宏利環球精選', re: /manulife\s*global\s*select\s*\(mpf\)\s*scheme/i },
  { id: 'hsbc', label: '滙豐智選', re: /hsbc\s*mandatory\s*provident\s*fund\s*-\s*supertrust\s*plus/i },
  { id: 'sunlife', label: '永明彩虹', re: /sun\s*life\s*rainbow\s*mpf\s*scheme/i },
  { id: 'aia', label: '友邦精選', re: /aia\s*mpf\s*-\s*prime\s*value\s*choice/i },
  { id: 'haitong', label: '海通退休金', re: /haitong\s*mpf\s*retirement\s*fund/i },
  { id: 'bocp', label: '中銀保誠簡易', re: /boc-prudential\s*easy-choice/i },
  { id: 'bct', label: 'BCT積金之選', re: /bct\s*\(mpf\)\s*pro\s*choice/i },
  { id: 'fidelity', label: '富達退休集成', re: /fidelity\s*retirement\s*master\s*trust/i },
  { id: 'principal', label: '信安800', re: /principal\s*mpf\s*scheme\s*series\s*800/i },
  { id: 'bea', label: '東亞享惠', re: /bea\s*\(mpf\)\s*master\s*trust\s*scheme/i },
];

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

// ---------- 1. 恒生網頁：最新每日價格 ----------
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
    out.push({ provider: 'hangseng', date, fund, bid: bid.toFixed(4), offer: (offer > 0 ? offer : bid).toFixed(4) });
  });
  console.log(`  ✔ 恒生網頁：成功取得 ${out.length} 隻基金，價格日期 ${date}`);
  return out;
}

// ---------- 2. 積金局：11大公司每月綜合價格表 ----------
async function fetchBuf(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2000 || buf.slice(0, 200).toString().toLowerCase().includes('<html')) throw new Error('非 Excel 檔案');
  return buf;
}
function lastDay(y, m) { return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }

function parseMpfaXls(buf, fallbackDate) {
  const XLSX = globalThis.__XLSX;
  const wb = XLSX.read(buf, { type: 'buffer' });
  const out = [];
  for (const sn of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: false, defval: '' });
    let date = '';
    for (const r of rows.slice(0, 15)) { const d = parseDate(r.join(' ')); if (d) { date = d; break; } }

    let currentProvider = null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].map(c => String(c || '').trim());
      const fullLine = r.join(' ');
      if (!fullLine.trim()) continue;

      const matchedTarget = TARGET_SCHEMES.find(s => s.re.test(fullLine));
      if (matchedTarget) {
        currentProvider = matchedTarget.id;
      } else {
        const firstCol = r[0] || '';
        if (firstCol.length > 5 && !/fund/i.test(firstCol) && /scheme|plan|trust|provident|mpf|aia|manulife|hsbc|sun\s*life|bct|boc|principal|fidelity|schroder|bea|hang\s*seng|haitong|fwd|massmutual|yf\s*life|china\s*life/i.test(firstCol)) {
          currentProvider = null;
          continue;
        }
      }

      if (!currentProvider) continue;

      const fundCell = r.find(c => /fund/i.test(c) && !TARGET_SCHEMES.some(s => s.re.test(c)));
      const numCells = r.map(c => c.replace(/,/g, '')).filter(c => /^\d{1,4}\.\d{2,}$/.test(c));
      const price = numCells.length ? +numCells[numCells.length - 1] : NaN;

      if (fundCell && price > 0 && price < 10000) {
        let fund = fundCell;
        TARGET_SCHEMES.forEach(s => { fund = fund.replace(s.re, ''); });
        fund = cleanName(fund.replace(/^[\s\-–—]+/, ''));
        if (fund && !/constituent\s*fund/i.test(fund)) {
          out.push({ provider: currentProvider, date: date || fallbackDate, fund, price: price.toFixed(4) });
        }
      }
    }
  }
  const map = new Map();
  out.forEach(r => map.set(r.provider + '|' + r.fund, r));
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

  const existingRows = readCsv('data/monthly.csv');
  const hasHaitong = existingRows.some(r => r.provider === 'haitong');
  const monthCounts = new Map();
  existingRows.forEach(r => monthCounts.set(r.date, (monthCounts.get(r.date) || 0) + 1));

  const out = [];
  let miss = 0, idx = 0;
  for (const [u, d] of [...urls].sort((a, b) => a[1] < b[1] ? 1 : -1)) {
    idx++;
    const needAutoMulti = !hasHaitong && idx <= 48;
    if ((monthCounts.get(d) || 0) >= 120 && !backfill && !needAutoMulti) continue;
    try {
      const rows = parseMpfaXls(await fetchBuf(u), d);
      if (!rows.length) continue;
      out.push(...rows); miss = 0;
      console.log(`  ✔ 積金局 ${d}：取得 ${rows.length} 隻基金（涵蓋 11 大受託人）`);
    } catch (e) {
      if (++miss >= 6 && backfill) break;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return out;
}

// ---------- 3. 進階量化引擎：10月均線 ＋ 斜率 ＋ 動能加速度 ＋ 1年高點回撤 ----------
const keyOf = (provider, name) => `${provider}_${String(name).toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '')}`;
const DAY = 86400000;
const toT = d => Date.parse(d + 'T00:00:00Z');
const isEquity = name => /equity|index|north america|europe|asia|chinese|china|hang seng|healthcare|tech|japan|pacific|us |u\.s\.|global|korea|taiwan/i.test(name)
  && !/bond|conservative|guaranteed|balanced|stable|growth|age 65|core|retirement|money market|interest|capital preservation/i.test(name);

function calcSmaAt(pts, targetT) {
  const vals = [];
  for (let m = 0; m < 10; m++) {
    const cut = targetT - m * 30.4375 * DAY;
    let best = null;
    for (const p of pts) { if (p.t <= cut) best = p; else break; }
    if (best) vals.push(best.v);
  }
  if (vals.length < 8) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function runAnalysis(dailyRows, monthlyRows) {
  const map = new Map();
  const add = (provider, name, d, v, isDaily) => {
    if (!d || !(v > 0)) return;
    const p = provider || 'hangseng';
    const k = keyOf(p, name);
    if (!map.has(k)) map.set(k, { key: k, provider: p, name, pts: new Map() });
    const f = map.get(k);
    if (isDaily) f.name = name;
    if (isDaily || !f.pts.has(d)) f.pts.set(d, { d, t: toT(d), v });
  };
  monthlyRows.forEach(r => add(r.provider, r.fund, r.date, +r.price, false));
  dailyRows.forEach(r => add(r.provider, r.fund, r.date, +r.bid, true));

  const results = [];
  for (const f of map.values()) {
    const pts = [...f.pts.values()].sort((a, b) => a.t - b.t);
    if (pts.length < 8) continue;
    const last = pts[pts.length - 1];

    const smaNow = calcSmaAt(pts, last.t);
    const sma1mAgo = calcSmaAt(pts, last.t - 31 * DAY);
    if (!smaNow) continue;

    const dev = last.v / smaNow - 1;
    const smaSlope = sma1mAgo ? (smaNow / sma1mAgo - 1) : 0;

    const getRet = days => {
      let base = null;
      for (const p of pts) { if (p.t <= last.t - days * DAY) base = p; else break; }
      return base ? (last.v / base.v - 1) : null;
    };
    const mom3 = getRet(91);
    const mom6 = getRet(182);

    // 計算距離過去 1 年最高點的回撤幅度
    const pts1y = pts.filter(p => p.t >= last.t - 365 * DAY);
    const high1y = pts1y.length ? Math.max(...pts1y.map(p => p.v)) : last.v;
    const ddFromHigh = last.v / high1y - 1;

    // 判斷綜合狀態（結合轉強 / 轉差先行預警）
    let state = 'WARN';
    if (dev <= -0.02) {
      state = 'BEAR'; // 長線跌浪
    } else if (dev >= 0.02 && (ddFromHigh <= -0.06 || (mom3 !== null && mom3 < -0.02))) {
      state = 'FADING'; // 高位回撤超6%或近一季轉負 -> 動能轉差預警
    } else if (mom3 !== null && mom6 !== null && (mom3 * 2 > mom6) && smaSlope > 0 && dev > -0.01) {
      state = 'RISING'; // 3月動能加速超越6月且均線向上 -> 加速轉強
    } else if (dev >= 0.02) {
      state = 'BULL'; // 穩步強勢
    }

    // 綜合強勢評分（用於 Top 5 排行榜）
    const score = (mom6 ?? 0) * 0.5 + (mom3 ?? 0) * 0.3 + dev * 0.2;

    results.push({
      key: f.key,
      provider: f.provider,
      name: f.name,
      date: last.d,
      price: last.v,
      sma10m: +smaNow.toFixed(4),
      dev: +(dev * 100).toFixed(2),
      mom3: mom3 != null ? +(mom3 * 100).toFixed(2) : null,
      mom6: mom6 != null ? +(mom6 * 100).toFixed(2) : null,
      dd: +(ddFromHigh * 100).toFixed(2),
      score: +(score * 100).toFixed(2),
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

// ---------- 主程式 ----------
console.log('▶ 1. 抓取最新每日價格（恒生網頁）');
try {
  const today = await scrapeHangSeng();
  const rows = readCsv('data/daily.csv');
  const key = r => (r.provider || 'hangseng') + '|' + r.date + '|' + r.fund;
  const map = new Map(rows.map(r => [{ ...r, provider: r.provider || 'hangseng' }].map(x => [key(x), x])[0]));
  let added = 0;
  today.forEach(r => { if (!map.has(key(r))) added++; map.set(key(r), r); });
  const all = [...map.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.fund < b.fund ? -1 : 1);
  writeCsv('data/daily.csv', ['provider', 'date', 'fund', 'bid', 'offer'], all);
  console.log(`  每日資料：新加入 ${added} 行，總計 ${all.length} 行`);
} catch (e) {
  console.log('✘ 恒生網頁讀取失敗：' + e.message);
}

console.log('▶ 2. 檢查積金局 11 大受託人每月價格表');
const monthly = await monthlyUpdate();
if (monthly.length) {
  const rows = readCsv('data/monthly.csv');
  const key = r => (r.provider || 'hangseng') + '|' + r.date + '|' + r.fund;
  const map = new Map(rows.map(r => [{ ...r, provider: r.provider || 'hangseng' }].map(x => [key(x), x])[0]));
  monthly.forEach(r => map.set(key(r), r));
  const all = [...map.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.fund < b.fund ? -1 : 1);
  writeCsv('data/monthly.csv', ['provider', 'date', 'fund', 'price'], all);
}

console.log('▶ 3. 執行全港 11 間公司長線趨勢與轉勢預警分析');
const analysis = runAnalysis(readCsv('data/daily.csv'), readCsv('data/monthly.csv'));
console.log(`  ✔ 成功完成 ${analysis.length} 隻基金的多維度量化分析`);

const prevFile = 'data/signals.json';
const prevData = fs.existsSync(prevFile) ? JSON.parse(fs.readFileSync(prevFile, 'utf8')) : { funds: [] };
const prevMap = new Map((prevData.funds || []).map(f => [f.key, f]));

const flips = [];
for (const cur of analysis) {
  if (!cur.isEquity) continue;
  const prev = prevMap.get(cur.key);
  if (prev && prev.state !== cur.state && ['BULL', 'BEAR', 'RISING', 'FADING'].includes(cur.state)) {
    flips.push({ ...cur, oldState: prev.state });
  }
}

const providerLabel = id => (TARGET_SCHEMES.find(s => s.id === id) || {}).label || id;
const topAll = analysis
  .filter(f => f.isEquity && f.mom6 !== null)
  .sort((a, b) => b.score - a.score)
  .slice(0, 5);

fs.writeFileSync(prevFile, JSON.stringify({ updated: new Date().toISOString(), funds: analysis }, null, 2) + '\n');
fs.writeFileSync('data/status.json', JSON.stringify({ updated: new Date().toISOString(), flipsCount: flips.length }) + '\n');

const latestDate = analysis[0]?.date || new Date().toISOString().slice(0, 10);
let reportLines = [
  `📊 <b>全港 MPF 長線趨勢與轉勢預警 (${latestDate})</b>`,
  ``,
  `🏆 <b>全場綜合強勢 Top 5 股票基金：</b>`
];
topAll.forEach((f, idx) => {
  reportLines.push(`${idx + 1}. [${providerLabel(f.provider)}] ${f.name}: 6月 <b>${f.mom6 > 0 ? '+' : ''}${f.mom6}%</b> | 3月 ${f.mom3 > 0 ? '+' : ''}${f.mom3}%`);
});

if (flips.length > 0) {
  reportLines.push(``, `🚨 <b>重要轉勢預警（正在轉強 / 轉差）：</b>`);
  flips.slice(0, 10).forEach(f => {
    const mapTxt = {
      RISING: '🚀 <b>加速轉強</b>（3月動能超越6月＋均線向上）',
      BULL: '🟢 <b>突破牛市 (+2%)</b> → 穩步強勢',
      FADING: '⚠️ <b>高位轉差</b>（回撤超6%或近季轉負）',
      BEAR: '🔴 <b>跌穿熊市 (-2%)</b> → 建議避險'
    };
    reportLines.push(`• [${providerLabel(f.provider)}] <b>${f.name}</b>: ${mapTxt[f.state]}`);
  });
  const msg = reportLines.join('\n');
  await sendTelegram(msg);
  fs.writeFileSync('alert_issue.md', msg.replace(/<b>/g, '**').replace(/<\/b>/g, '**'));
} else if (process.env.FORCE_NOTIFY === 'true') {
  await sendTelegram(reportLines.join('\n') + '\n\n✅ 系統運作正常（今日無新轉勢訊號）');
}
