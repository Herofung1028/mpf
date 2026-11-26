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
  m = t.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
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

// ---------- 1b. 其他受託人每日價格（香港經濟日報每日價目表 ＋ 信安官網） ----------
// 註：海通暫未找到公開每日價目來源，繼續使用積金局每月數據
const DAILY_SOURCES = [
  { id: 'manulife', urls: ['https://invest.hket.com/fundmpf/daily/MPF_manulife.html'] },
  { id: 'hsbc', urls: ['https://invest.hket.com/fundmpf/daily/MPF_hsbc.html'] },
  { id: 'sunlife', urls: ['https://invest.hket.com/fundmpf/daily/MPF_sunlife.html'] },
  { id: 'aia', urls: ['https://invest.hket.com/fundmpf/daily/MPF_aia.html'] },
  { id: 'bocp', urls: ['https://invest.hket.com/fundmpf/daily/MPF_bociptl.html', 'https://invest.hket.com/fundmpf/daily/MPF_bocipam.html'] },
  { id: 'bct', urls: ['https://invest.hket.com/fundmpf/daily/MPF_bct.html'] },
  { id: 'fidelity', urls: ['https://invest.hket.com/fundmpf/daily/MPF_fidelity.html'] },
  { id: 'bea', urls: ['https://invest.hket.com/fundmpf/daily/MPF_bea.html'] },
  { id: 'principal', urls: ['https://www.principal.com.hk/products/mpf-schemes/daily-constituent-fund-prices'] },
];

async function scrapeOtherDaily() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
  const context = await browser.newContext({ userAgent: UA, locale: 'zh-HK', timezoneId: 'Asia/Hong_Kong' });
  const page = await context.newPage();
  const out = [];
  for (const src of DAILY_SOURCES) {
    for (const url of src.urls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
        const rows = await page.evaluate(() => {
          const res = [];
          document.querySelectorAll('tr').forEach(tr => {
            const cells = [...tr.querySelectorAll('th,td')].map(c => c.innerText.replace(/\s+/g, ' ').trim());
            if (cells.length < 2) return;
            const date = cells.find(c => /^\d{1,2}[\/-]\d{1,2}[\/-]\d{4}$/.test(c)) || '';
            const nums = cells.filter(c => /^(HK)?\$?\s*\d{1,5}\.\d+$/.test(c.replace(/,/g, '')));
            const name = cells.find(c => /[一-鿿A-Za-z]{2,}/.test(c) && !/^(HK\$|HKD|港元)$/i.test(c));
            if (name && nums.length) res.push({ name, nums, date });
          });
          return res;
        });
        let n = 0;
        rows.forEach(r => {
          const date = parseDate(r.date);
          const v = num(r.nums[0]);
          if (!date || !(v > 0)) return;
          out.push({ provider: src.id, date, fund: cleanName(r.name), bid: v.toFixed(4), offer: v.toFixed(4), src: url });
          n++;
        });
        console.log(`  ${n ? '✔' : '⚠'} ${src.id}：${url.split('/').pop()} 讀取 ${n} 行`);
      } catch (e) {
        console.log(`  ⚠ ${src.id} 讀取失敗：${e.message.split('\n')[0]}`);
      }
    }
  }
  await browser.close();
  return out;
}

// ---------- 1c. 基金名稱配對：把每日來源的名稱統一為積金局（MPFA）名稱 ----------
// 解決「同一隻基金在不同來源寫法不同 → 被拆成兩條走勢線」的問題
const ZH_DICT = [
  [/核心累積/g, ' core accumulation '], [/65歲後/g, ' age 65 plus '], [/恒指|恒生指數/g, ' hang seng index '],
  [/國企|中國企業/g, ' china enterprises '], [/北美|美洲/g, ' north america '], [/美國/g, ' united states '],
  [/香港/g, ' hong kong '], [/大中華|中華|中國|中港/g, ' china chinese '], [/亞太/g, ' asia pacific '],
  [/亞洲/g, ' asia asian '], [/亞歐/g, ' eurasia '], [/歐洲/g, ' europe european '], [/日本/g, ' japan '],
  [/環球|全球|國際|世界/g, ' global international world '], [/債券/g, ' bond '], [/保守/g, ' conservative '],
  [/保證|保本/g, ' guaranteed '], [/增長/g, ' growth '], [/平衡|均衡/g, ' balanced '], [/穩定|穩健|平穩/g, ' stable '],
  [/股票/g, ' equity '], [/追蹤/g, ' tracker '], [/指數/g, ' index '], [/人民幣/g, ' rmb '], [/退休/g, ' retirement '],
  [/入息|收益/g, ' income '], [/康健|醫療|健康/g, ' healthcare '], [/科技/g, ' tech '], [/港元/g, ' hkd '],
];
const STOP = new Set(['fund', 'funds', 'mpf', 'the', 'and', 'of', 'class', 'scheme', 'portfolio', 'manulife', 'aia', 'principal', 'bea', 'bct', 'sun', 'life', 'fidelity', 'boc', 'prudential', 'hsbc', 'haitong', 'supertrust', 'mandatory', 'provident', 'constituent']);
function nameTokens(name) {
  let s = String(name).replace(/\(.*?\)|（.*?）/g, ' ');
  ZH_DICT.forEach(([re, en]) => { s = s.replace(re, en); });
  s = s.toLowerCase().replace(/基金|計劃|強積金/g, ' ').replace(/^[\s-]*hang\s*seng\s+(?!index|china)/, ' ');
  const toks = s.replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(t => t && !STOP.has(t));
  return toks.map(t => ({ american: 'america', european: 'europe', asian: 'asia', chinese: 'china', us: 'united', 'u': 'united' }[t] || t));
}
function similarity(a, b) {
  const A = new Set(nameTokens(a)), B = new Set(nameTokens(b));
  const inter = [...A].filter(x => B.has(x)).length;
  return inter / (new Set([...A, ...B]).size || 1);
}
// history: Map(provider|fund → [{t,v}]) 已排序
function priceNear(hist, t) {
  let best = null;
  for (const p of hist) { if (p.t <= t) best = p; else break; }
  return best || hist[0];
}
function buildHistory(monthlyRows, canonDailyRows) {
  const h = new Map();
  const push = (p, f, d, v) => { if (!(v > 0)) return; const k = p + '|' + f; if (!h.has(k)) h.set(k, []); h.get(k).push({ t: Date.parse(d + 'T00:00:00Z'), v }); };
  monthlyRows.forEach(r => push(r.provider || 'hangseng', r.fund, r.date, +r.price));
  canonDailyRows.forEach(r => push(r.provider || 'hangseng', r.fund, r.date, +r.bid));
  h.forEach(arr => arr.sort((a, b) => a.t - b.t));
  return h;
}
// 為一批 { name, date, v } 找出對應的積金局名稱（同一受託人內，一對一）
function matchNames(provider, items, hist, nameMap) {
  const cands = [...hist.keys()].filter(k => k.startsWith(provider + '|')).map(k => k.slice(provider.length + 1));
  const result = new Map(), log = [];
  const pairs = [];
  for (const it of items) {
    const t = Date.parse(it.date + 'T00:00:00Z');
    for (const c of cands) {
      const ref = priceNear(hist.get(provider + '|' + c), t);
      const ratio = it.v / ref.v, gap = Math.abs(t - ref.t) / 86400000;
      const tol = gap <= 10 ? 0.05 : gap <= 40 ? 0.12 : 0.2;
      if (Math.abs(Math.log(ratio)) > tol) continue;
      const sim = similarity(it.name, c);
      const remembered = nameMap[it.name] === c;
      if (!remembered && sim < 0.25 && !(gap <= 10 && Math.abs(ratio - 1) < 0.003)) continue;
      pairs.push({ it, c, score: sim * 2 - Math.abs(Math.log(ratio)) * 6 + (remembered ? 3 : 0), sim, ratio, gap });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const usedC = new Set();
  for (const p of pairs) {
    if (result.has(p.it.name) || usedC.has(p.c)) continue;
    result.set(p.it.name, p.c); usedC.add(p.c);
    log.push({ provider, source: p.it.name, matched: p.c, sim: +p.sim.toFixed(2), priceRatio: +p.ratio.toFixed(4), gapDays: Math.round(p.gap) });
  }
  items.forEach(it => { if (!result.has(it.name)) log.push({ provider, source: it.name, matched: null, price: it.v, date: it.date }); });
  return { result, log };
}
// 把每日行的 fund 名稱統一為積金局名稱；無法配對的保留原名（若該受託人沒有積金局數據）或剔除
function canonicalizeDaily(rows, monthlyRows) {
  const mapFile = 'data/name_map.json';
  const nameMap = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, 'utf8')) : {};
  const monthlyNames = new Set(monthlyRows.map(r => (r.provider || 'hangseng') + '|' + r.fund));
  const isCanon = r => monthlyNames.has(r.provider + '|' + r.fund);
  const hist = buildHistory(monthlyRows, rows.filter(isCanon));
  const byProv = new Map();
  rows.filter(r => !isCanon(r)).forEach(r => {
    if (!byProv.has(r.provider)) byProv.set(r.provider, new Map());
    const m = byProv.get(r.provider);
    // 以該名稱最早一行做配對（與積金局歷史重疊最多）
    if (!m.has(r.fund) || r.date < m.get(r.fund).date) m.set(r.fund, { name: r.fund, date: r.date, v: +r.bid });
  });
  const rename = new Map(), fullLog = [];
  byProv.forEach((m, provider) => {
    const hasMonthly = [...hist.keys()].some(k => k.startsWith(provider + '|'));
    if (!hasMonthly) return; // 該受託人未有積金局數據：保留原名
    nameMap[provider] = nameMap[provider] || {};
    const { result, log } = matchNames(provider, [...m.values()], hist, nameMap[provider]);
    result.forEach((c, src) => { rename.set(provider + '|' + src, c); nameMap[provider][src] = c; });
    fullLog.push(...log);
  });
  const out = [];
  let dropped = 0;
  rows.forEach(r => {
    if (isCanon(r)) return out.push(r);
    const c = rename.get(r.provider + '|' + r.fund);
    if (c) return out.push({ ...r, fund: c });
    const hasMonthly = [...hist.keys()].some(k => k.startsWith(r.provider + '|'));
    if (!hasMonthly || r.provider === 'hangseng') return out.push(r); // 恒生原有每日數據不刪除
    dropped++;
  });
  fs.writeFileSync(mapFile, JSON.stringify(nameMap, null, 2) + '\n');
  fs.writeFileSync('debug/daily_name_match.json', JSON.stringify(fullLog, null, 2) + '\n');
  const unmatched = fullLog.filter(x => !x.matched).length;
  console.log(`  名稱配對：統一 ${rename.size} 個名稱，未能配對 ${unmatched} 個（略過 ${dropped} 行，詳見 debug/daily_name_match.json）`);
  // 同一 provider|date|fund 只保留一行（優先保留較新來源）
  const dedup = new Map();
  out.forEach(r => dedup.set(r.provider + '|' + r.date + '|' + r.fund, r));
  return [...dedup.values()];
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
// 先更新積金局每月數據（作為名稱配對的基準），再處理每日價格
console.log('▶ 1. 檢查積金局 11 大受託人每月價格表');
const monthly = await monthlyUpdate();
if (monthly.length) {
  const rows = readCsv('data/monthly.csv');
  const key = r => (r.provider || 'hangseng') + '|' + r.date + '|' + r.fund;
  const map = new Map(rows.map(r => [{ ...r, provider: r.provider || 'hangseng' }].map(x => [key(x), x])[0]));
  monthly.forEach(r => map.set(key(r), r));
  const all = [...map.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.fund < b.fund ? -1 : 1);
  writeCsv('data/monthly.csv', ['provider', 'date', 'fund', 'price'], all);
}

console.log('▶ 2. 抓取最新每日價格（恒生網頁 ＋ 經濟日報／信安每日價目）');
const newDaily = [];
try { newDaily.push(...await scrapeHangSeng()); } catch (e) { console.log('✘ 恒生網頁讀取失敗：' + e.message); }
try { newDaily.push(...await scrapeOtherDaily()); } catch (e) { console.log('✘ 其他受託人每日價格讀取失敗：' + e.message); }
{
  const oldRows = readCsv('data/daily.csv').map(r => ({ ...r, provider: r.provider || 'hangseng' }));
  const key = r => r.provider + '|' + r.date + '|' + r.fund;
  const before = new Set(oldRows.map(key));
  // 統一名稱（包括修正舊數據中被拆開的恒生基金名稱）
  const merged = canonicalizeDaily([...oldRows, ...newDaily.map(({ src, ...r }) => r)], readCsv('data/monthly.csv'));
  const added = merged.filter(r => !before.has(key(r))).length;
  const all = merged.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.fund < b.fund ? -1 : 1);
  writeCsv('data/daily.csv', ['provider', 'date', 'fund', 'bid', 'offer'], all);
  console.log(`  每日資料：新加入 ${added} 行，總計 ${all.length} 行`);
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

const latestDate = analysis.reduce((m, f) => f.date > m ? f.date : m, '') || new Date().toISOString().slice(0, 10);
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
