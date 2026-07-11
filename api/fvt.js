// ORKA FVT proxy
// Price:        /api/fvt?code=TLY&mode=price
// Distribution: /api/fvt?code=TLY&mode=distribution

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept');
}
function cleanCode(code) {
  return String(code || '').toUpperCase().trim().replace(/[^A-Z0-9]/g, '');
}
function toNumber(value) {
  if (value === null || value === undefined || value === '') return NaN;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  let s = String(value).replace(/<[^>]*>/g, '').replace(/TL|TRY|₺|%/gi, '').replace(/\s+/g, '').trim();
  if (!s) return NaN;
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}
function fvtHeaders(code) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.7,en;q=0.6',
    'Referer': `https://fvt.com.tr/fonlar/yatirim-fonlari/${encodeURIComponent(code)}`,
    'Origin': 'https://fvt.com.tr',
    'Cache-Control': 'no-cache'
  };
}
function priceUrls(code) {
  const c = encodeURIComponent(code);
  return [
    `https://fvt.com.tr/api/funds/${c}`,
    `https://www.fvt.com.tr/api/funds/${c}`
  ];
}
function distributionUrls(code) {
  const c = encodeURIComponent(code);
  return [
    `https://fvt.com.tr/api/funds/${c}/distribution`,
    `https://www.fvt.com.tr/api/funds/${c}/distribution`
  ];
}
function pickNumber(obj, keys) {
  if (!obj || typeof obj !== 'object') return NaN;
  for (const k of keys) {
    if (obj[k] !== undefined) {
      const n = toNumber(obj[k]);
      if (Number.isFinite(n)) return n;
    }
  }
  return NaN;
}
function pickDate(row) {
  return row && (row.tarih || row.TARIH || row.Tarih || row.date || row.DATE || row.createdAt || row.gun || row.GUN || '');
}
function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  m = s.match(/^(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
function findArrayDeep(root, preferredKeys) {
  if (!root || typeof root !== 'object') return [];
  for (const key of preferredKeys) if (Array.isArray(root[key])) return root[key];
  for (const value of Object.values(root)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const found = findArrayDeep(value, preferredKeys);
      if (found.length) return found;
    }
  }
  return [];
}
function normalizePricePayload(raw, code) {
  const top = raw && raw.data ? raw.data : raw || {};
  const fund = top.fund || top.fon || top.info || top.fundInfo || top;
  const history = findArrayDeep(top, ['priceHistory','fiyatGecmisi','history','prices','fundPrices','fonFiyatlari','items']);
  const rows = history.map(row => ({
    date: pickDate(row),
    price: pickNumber(row, ['fiyat','FIYAT','Fiyat','price','PRICE','fonFiyat','FONFIYAT','value','VALUE'])
  })).filter(row => row.date && Number.isFinite(row.price) && row.price > 0)
    .sort((a,b) => (parseDate(a.date)?.getTime() || 0) - (parseDate(b.date)?.getTime() || 0));

  const rates = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i-1].price, cur = rows[i].price;
    if (prev > 0 && cur > 0) rates.push({ date: rows[i].date, price: cur, dailyReturn: Number((((cur-prev)/prev)*100).toFixed(6)) });
  }
  const last = rows[rows.length - 1] || {};
  let price = last.price || pickNumber(fund, ['fiyat','FIYAT','Fiyat','price','PRICE','fonFiyat','FONFIYAT']);
  let dailyReturn = pickNumber(fund, ['gunlukGetiri','GUNLUKGETIRI','GunlukGetiri','dailyReturn','DAILYRETURN','getiri','GETIRI']);
  if (!Number.isFinite(dailyReturn) && rates.length) dailyReturn = rates[rates.length - 1].dailyReturn;
  return {
    code,
    name: fund.fonUnvan || fund.FONUNVAN || fund.unvan || fund.name || code,
    price: Number.isFinite(price) ? price : 0,
    dailyReturn: Number.isFinite(dailyReturn) ? dailyReturn : 0,
    weeklyReturn: Number.isFinite(pickNumber(fund, ['haftalikGetiri','weeklyReturn'])) ? pickNumber(fund, ['haftalikGetiri','weeklyReturn']) : 0,
    monthlyReturn: Number.isFinite(pickNumber(fund, ['aylikGetiri','monthlyReturn'])) ? pickNumber(fund, ['aylikGetiri','monthlyReturn']) : 0,
    size: Number.isFinite(pickNumber(fund, ['portfoyBuyuklugu','portfoyBuyukluk','size'])) ? pickNumber(fund, ['portfoyBuyuklugu','portfoyBuyukluk','size']) : 0,
    investors: Number.isFinite(pickNumber(fund, ['yatirimciSayisi','investors'])) ? Math.trunc(pickNumber(fund, ['yatirimciSayisi','investors'])) : 0,
    date: last.date || fund.tarih || fund.date || '',
    history: rates
  };
}
async function fetchJsonCandidates(urls, code) {
  const attempts = [];
  for (const url of urls) {
    try {
      const upstream = await fetch(url, { headers: fvtHeaders(code), redirect: 'follow' });
      const text = await upstream.text();
      attempts.push({ url, status: upstream.status, len: text.length, contentType: upstream.headers.get('content-type') || '' });
      if (!upstream.ok) continue;
      try { return { data: JSON.parse(text), url, attempts }; }
      catch (e) { attempts[attempts.length-1].jsonError = e.message; }
    } catch (e) { attempts.push({ url, error: e.message || String(e) }); }
  }
  return { data: null, url: '', attempts };
}
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok:false, error:'Only GET is supported' });
  const code = cleanCode(req.query?.code || req.query?.kod || req.query?.fon || '');
  const mode = String(req.query?.mode || req.query?.type || 'price').toLowerCase();
  const debug = String(req.query?.debug || '') === '1';
  if (!code) return res.status(400).json({ ok:false, error:'Missing code parameter' });

  if (mode === 'distribution') {
    const r = await fetchJsonCandidates(distributionUrls(code), code);
    const items = r.data?.data?.items || r.data?.items || [];
    if (!Array.isArray(items) || !items.length) return res.status(200).json({ ok:false, code, error:'FVT distribution empty', attempts:debug?r.attempts:undefined });
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
    return res.status(200).json({ ok:true, code, source:r.url, success:r.data?.success, data:r.data?.data || r.data, timestamp:r.data?.timestamp, debug:debug?{attempts:r.attempts}:undefined });
  }

  const r = await fetchJsonCandidates(priceUrls(code), code);
  if (!r.data) return res.status(200).json({ ok:false, code, error:'FVT price endpoint failed', attempts:debug?r.attempts:undefined });
  const info = normalizePricePayload(r.data, code);
  if (!info.price && !info.history.length) return res.status(200).json({ ok:false, code, error:'FVT price/history empty', attempts:debug?r.attempts:undefined });
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  return res.status(200).json({ ok:true, source:'FVT', sourceUrl:r.url, code, info, history:info.history, debug:debug?{attempts:r.attempts}:undefined });
}
