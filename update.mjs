// 恒生強積金智選計劃：基金價格自動更新（由 GitHub Actions 執行）
//   node update.mjs          → 讀取恒生網頁嘅最新每日價格，並檢查積金局有冇新一個月嘅價格表
//   node update.mjs backfill → 另外盡量下載積金局以前月份嘅價格表（第一次設定時用）
// 輸出：
//   data/daily.csv    date,fund,bid,offer      （恒生網頁，每日）
//   data/monthly.csv  date,fund,price          （積金局每月綜合價格表）

import fs from 'node:fs';

const HS_PAGES = process.env.HS_URL ? [process.env.HS_URL] : [
  'https://www.hangseng.com/en-hk/personal/insurance-mpf/e-mpf/fund-price-performance/',
  'https://www.hangseng.com/e-services/e-mpf/fund-price-performance',
];
const MPFA_LIST = process.env.MPFA_URL || 'https://www.mpfa.org.hk/en/info-centre/fund-information/monthly-fund-price/monthly-unit-prices-of-mpf-constituent-funds';
const MPFA_FILE = (mon, yy) => `https://www.mpfa.org.hk/en/-/media/files/information-centre/fund-information/monthly-fund-price/consolidated_list_for_${mon}_${yy}_read_only.xls`;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const SCHEME = /hang\s*seng\s*mandatory\s*provident\s*fund/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const backfill = process.argv[2] === 'backfill';

fs.mkdirSync('data', { recursive: true });
fs.mkdirSync('debug', { recursive: true });

// ---------- CSV ----------
function readCsv(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
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
  m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);   // dd/mm/yyyy（香港格式）
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

// ---------- 1. 恒生網頁：每日價格 ----------
async function scrapeHangSeng() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: UA, locale: 'en-HK', timezoneId: 'Asia/Hong_Kong' });
  const seenJson = [];
  page.on('response', async res => {
    try {
      const ct = res.headers()['content-type'] || '';
      if (!/json/i.test(ct)) return;
      const body = await res.text();
      if (/price|bid|offer|nav/i.test(body)) {
        seenJson.push(res.url());
        fs.writeFileSync(`debug/json_${seenJson.length}.txt`, res.url() + '\n\n' + body.slice(0, 20000));
      }
    } catch (e) {}
  });
  let result = null, lastErr = '';
  for (const url of HS_PAGES) {
    try {
      console.log('  打開 ' + url);
      await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
      // 等到表格出現數字價格
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
        const m = body.match(/(unit\s*price[s]?\s*(as\s*at|as\s*of)?|valuation\s*date)[^\n]{0,40}/i);
        return { rows, dateText: m ? m[0] : '', html: document.documentElement.outerHTML.length };
      });
      await page.screenshot({ path: 'debug/hangseng.png', fullPage: true });
      if (data.rows.length) { result = data; break; }
      lastErr = '頁面冇價格表';
    } catch (e) { lastErr = e.message.split('\n')[0]; console.log('  ⚠ ' + lastErr); }
  }
  if (!result) {
    try { await page.screenshot({ path: 'debug/hangseng.png', fullPage: true }); fs.writeFileSync('debug/hangseng.html', await page.content()); } catch (e) {}
  }
  await browser.close();
  if (seenJson.length) console.log('  ℹ 網頁讀取咗以下 JSON（已存入 debug/）：\n    ' + seenJson.join('\n    '));
  if (!result) throw new Error(lastErr || '讀取失敗');
  let date = parseDate(result.dateText);
  if (!date) {
    const hk = new Date(Date.now() + 8 * 3600e3);
    date = hk.toISOString().slice(0, 10);
    console.log(`  ⚠ 搵唔到價格日期（「${result.dateText}」），暫用香港今日日期 ${date}`);
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
  console.log(`  ✔ 恒生網頁：${out.length} 隻基金，價格日期 ${date}`);
  return out;
}

// ---------- 2. 積金局：每月綜合價格表 ----------
async function fetchBuf(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2000 || buf.slice(0, 200).toString().toLowerCase().includes('<html')) throw new Error('唔係 Excel 檔案');
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
    // 搵表頭：有 scheme／fund 同 price／nav 字眼
    let hi = rows.findIndex(r => r.some(c => /scheme/i.test(c)) && r.some(c => /fund/i.test(c)));
    if (hi < 0) hi = rows.findIndex(r => r.some(c => /constituent/i.test(c)));
    const head = hi >= 0 ? rows[hi].map(c => String(c)) : [];
    const col = re => head.findIndex(c => re.test(c));
    const cScheme = col(/scheme/i), cFund = col(/constituent|fund name/i);
    let cPrice = col(/unit\s*price|nav|price/i);
    let scheme = '';
    for (let i = hi + 1; i < rows.length; i++) {
      const r = rows[i];
      const txt = r.join(' | ');
      if (cScheme >= 0 && r[cScheme]) scheme = r[cScheme];
      else if (SCHEME.test(txt) && !r.some(c => /^\s*\d+(\.\d+)?\s*$/.test(String(c).replace(/,/g, '')))) scheme = txt;  // 分組標題行
      const isHS = SCHEME.test(scheme) || SCHEME.test(txt);
      if (!isHS) continue;
      let fund = cFund >= 0 ? r[cFund] : '';
      let price = cPrice >= 0 ? num(r[cPrice]) : NaN;
      if (!fund) fund = r.find(c => /fund/i.test(c) && !SCHEME.test(c)) || '';
      if (!(price > 0)) { const n = r.map(c => String(c).replace(/,/g, '')).filter(c => /^\d{1,4}\.\d{2,}$/.test(c.trim())); price = n.length ? +n[n.length - 1] : NaN; }
      fund = cleanName(String(fund).replace(SCHEME, '').replace(/^[\s\-–—]*(supertrust plus)?[\s\-–—]*/i, ''));
      if (fund && price > 0 && price < 10000) out.push({ date: date || fallbackDate, fund, price: price.toFixed(4) });
    }
  }
  // 同一隻基金只留一個
  const map = new Map(); out.forEach(r => map.set(r.fund, r));
  return [...map.values()];
}
async function monthlyUpdate() {
  try { globalThis.__XLSX = (await import('xlsx')).default; } catch (e) { console.log('  ⚠ 未安裝 xlsx，略過每月資料'); return []; }
  const urls = new Map();   // url → 月底日期
  try {
    const html = await (await fetch(MPFA_LIST, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) })).text();
    for (const m of html.matchAll(/href="([^"]*consolidated_list_for_([a-z]{3})_(\d{2})[^"]*\.xlsx?)"/gi)) {
      const u = new URL(m[1].replace(/&amp;/g, '&'), MPFA_LIST).href;
      urls.set(u, lastDay(2000 + +m[3], MON[m[2].toLowerCase()]));
    }
    console.log(`  積金局網頁列出 ${urls.size} 個月份`);
  } catch (e) { console.log('  ⚠ 讀取積金局網頁失敗：' + e.message); }
  if (backfill) {
    const now = new Date();
    for (let k = 1; k <= 120; k++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
      const u = MPFA_FILE(MONTHS[d.getUTCMonth()], String(d.getUTCFullYear()).slice(2));
      if (![...urls.keys()].some(x => x.toLowerCase() === u.toLowerCase())) urls.set(u, lastDay(d.getUTCFullYear(), d.getUTCMonth() + 1));
    }
  }
  const have = new Set(readCsv('data/monthly.csv').map(r => r.date));
  const out = [];
  let miss = 0;
  for (const [u, d] of [...urls].sort((a, b) => a[1] < b[1] ? 1 : -1)) {
    if (have.has(d) && !backfill) continue;
    try {
      const rows = parseMpfaXls(await fetchBuf(u), d);
      if (!rows.length) { console.log(`  ⚠ ${d}：檔案入面搵唔到恒生計劃`); fs.writeFileSync('debug/mpfa_sample.txt', u); continue; }
      out.push(...rows); miss = 0;
      console.log(`  ✔ 積金局 ${d}：${rows.length} 隻基金`);
    } catch (e) {
      if (++miss >= 6 && backfill) { console.log('  連續 6 個月下載唔到，停止向前搵'); break; }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return out;
}

// ---------- 主程式 ----------
let changed = false;
console.log('▶ 每日價格（恒生網頁）');
try {
  const today = await scrapeHangSeng();
  const rows = readCsv('data/daily.csv');
  const key = r => r.date + '|' + r.fund;
  const map = new Map(rows.map(r => [key(r), r]));
  let added = 0;
  today.forEach(r => { if (!map.has(key(r))) added++; map.set(key(r), r); });
  const all = [...map.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.fund < b.fund ? -1 : 1);
  if (writeCsv('data/daily.csv', ['date', 'fund', 'bid', 'offer'], all)) changed = true;
  console.log(`  每日資料：新加入 ${added} 行，共 ${all.length} 行`);
} catch (e) {
  console.log('✘ 恒生網頁讀取失敗：' + e.message + '（截圖已存入 debug/hangseng.png）');
}

console.log('▶ 每月價格（積金局）');
const monthly = await monthlyUpdate();
if (monthly.length) {
  const rows = readCsv('data/monthly.csv');
  const key = r => r.date + '|' + r.fund;
  const map = new Map(rows.map(r => [key(r), r]));
  monthly.forEach(r => map.set(key(r), r));
  const all = [...map.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.fund < b.fund ? -1 : 1);
  if (writeCsv('data/monthly.csv', ['date', 'fund', 'price'], all)) changed = true;
  console.log(`  每月資料：共 ${new Set(all.map(r => r.date)).size} 個月`);
}

fs.writeFileSync('data/status.json', JSON.stringify({ updated: new Date().toISOString() }) + '\n');
console.log(changed ? '✔ 資料有更新' : 'ℹ 資料冇變動');
