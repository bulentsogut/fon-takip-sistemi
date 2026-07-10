// ORKA v15 - Ekofin data service
// /api/ekofin?code=TLY[&mode=info][&debug=1]
// Amaç: Ekofin'i tek ana kaynak yapmak; fiyat, hisse portföyü ve taşınan fonlar
// birbirinden bağımsız okunur. Bir bölüm bozulursa diğer bölümler düşmez.

import https from 'node:https';
import zlib from 'node:zlib';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

function cleanCode(code) {
  return String(code || '').toUpperCase().trim().replace(/[^A-Z0-9]/g, '');
}

function toNumber(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return value;
  let x = String(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/%/g, '')
    .replace(/TL|₺/gi, '')
    .replace(/,/g, ',')
    .trim()
    .replace(/\s+/g, '');
  if (!x) return NaN;
  if (x.includes(',') && x.includes('.')) x = x.replace(/\./g, '').replace(',', '.');
  else x = x.replace(',', '.');
  return Number.parseFloat(x);
}

function decodeBody(buffer, headers) {
  const enc = String((headers && headers['content-encoding']) || '').toLowerCase();
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buffer).toString('utf8');
    if (enc.includes('gzip')) return zlib.gunzipSync(buffer).toString('utf8');
    if (enc.includes('deflate')) return zlib.inflateSync(buffer).toString('utf8');
  } catch (_) {}
  return buffer.toString('utf8');
}

function httpsGet(url, timeoutMs = 18000, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get(url, {
      timeout: timeoutMs,
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 6.3; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json,text/plain,*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.6',
        'Origin': 'https://ekofin.net',
        'Referer': u.hostname === 'api.ekofin.net' ? 'https://ekofin.net/' : 'https://ekofin.net/fonlar',
        'Cache-Control': 'no-cache'
      }, extraHeaders || {})
    }, (r) => {
      const chunks = [];
      r.on('data', chunk => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
      r.on('end', () => {
        const headers = r.headers || {};
        const body = decodeBody(Buffer.concat(chunks), headers);
        resolve({ status: r.statusCode || 0, headers, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Ekofin request timeout')));
    req.on('error', reject);
  });
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#x27;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

const TR_MONTHS = {
  'ocak': '01', 'şubat': '02', 'subat': '02', 'mart': '03', 'nisan': '04',
  'mayıs': '05', 'mayis': '05', 'haziran': '06', 'temmuz': '07', 'ağustos': '08',
  'agustos': '08', 'eylül': '09', 'eylul': '09', 'ekim': '10', 'kasım': '11',
  'kasim': '11', 'aralık': '12', 'aralik': '12'
};

function extractDate(html) {
  const text = stripTags(html);
  const m = text.match(/(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]+)\s+(\d{4})\s+tarihinde/i);
  if (!m) return '';
  const mm = TR_MONTHS[String(m[2] || '').toLowerCase()];
  return mm ? `${m[3]}-${mm}-${String(m[1]).padStart(2, '0')}` : '';
}

function addHolding(out, seen, item) {
  const code = cleanCode(item && (item.code || item.symbol || item.kod));
  if (!code || seen.has(code)) return;
  const weight = toNumber(item && (item.weight ?? item.agirlik ?? item.oran ?? item.PORTFOY_ORAN));
  if (!Number.isFinite(weight) || Math.abs(weight) < 0.005 || Math.abs(weight) > 100) return;
  const type = item.type || item.tip || 'bist';
  seen.add(code);
  out.push({
    code,
    symbol: code,
    name: item.name || item.ad || code,
    weight: Number(weight.toFixed(4)),
    type,
    tip: type,
    nominal: Number.isFinite(toNumber(item.nominal)) ? toNumber(item.nominal) : NaN,
    value: Number.isFinite(toNumber(item.value)) ? toNumber(item.value) : NaN
  });
}

function mergeHoldings(...lists) {
  const out = [];
  const map = new Map();
  for (const list of lists) {
    for (const h of (list || [])) {
      const code = cleanCode(h && (h.code || h.symbol));
      const weight = toNumber(h && h.weight);
      if (!code || !Number.isFinite(weight)) continue;
      const prev = map.get(code) || {};
      map.set(code, Object.assign({}, prev, h, { code, symbol: code, weight: Number(weight.toFixed(4)), type: h.type || prev.type || 'bist', tip: h.type || prev.type || 'bist' }));
    }
  }
  for (const v of map.values()) out.push(v);
  out.sort((a, b) => (toNumber(b.weight) || 0) - (toNumber(a.weight) || 0));
  return out;
}

function normalizeHistoricalRows(rows, fundCode) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const sameFund = rows.filter(r => cleanCode(r.FON_KODU || r.fonKodu || r.fon_kodu) === fundCode);
  const source = sameFund.length ? sameFund : rows;
  const dates = source.map(r => String(r.DONEM_TARIHI || r.donemTarihi || r.date || '')).filter(Boolean).sort();
  const latest = dates.length ? dates[dates.length - 1] : '';
  const latestRows = latest ? source.filter(r => String(r.DONEM_TARIHI || r.donemTarihi || r.date || '') === latest) : source;
  const out = [];
  const seen = new Set();
  for (const r of latestRows) {
    const rawType = String(r.TYPE || r.type || '').toUpperCase();
    let type = rawType === 'FUND' ? 'fund' : 'bist';
    addHolding(out, seen, {
      code: r.HISSE_ADI || r.hisseAdi || r.code || r.symbol,
      name: r.HISSE_ADI || r.hisseAdi || r.code || r.symbol,
      weight: r.PORTFOY_ORAN ?? r.portfoyOran ?? r.weight,
      type,
      nominal: r.NOMINAL_DEGER,
      value: r.TOPLAM_DEGER
    });
  }
  return out;
}

function rowsFromJsonText(text) {
  try {
    const data = JSON.parse(text || 'null');
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.data)) return data.data;
    if (data && Array.isArray(data.result)) return data.result;
    if (data && Array.isArray(data.items)) return data.items;
    if (data && data.data && Array.isArray(data.data.items)) return data.data.items;
  } catch (_) {}
  return [];
}

function extractAnchorHoldings(html, fundCode, mode) {
  const out = [];
  const seen = new Set();
  const anchorRe = /<a\b[^>]*href="\/(sirket|fonlar)\/detay\/([A-Za-z0-9]+)(?:\/[^\"]*)?"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html || ''))) {
    const kind = String(m[1] || '').toLowerCase();
    const code = cleanCode(m[2]);
    if (!code || code === fundCode) continue;
    if (mode === 'portfolio' && kind !== 'sirket') continue;
    if (mode === 'carried' && kind !== 'fonlar') continue;
    const inner = stripTags(m[3]);
    if (!inner || !/%/.test(inner)) continue;
    const pcts = [...inner.matchAll(/(-?\d+(?:[\.,]\d+)?)\s*%/g)].map(x => x[1]);
    if (!pcts.length) continue;
    addHolding(out, seen, { code, name: code, weight: pcts[pcts.length - 1], type: kind === 'fonlar' ? 'fund' : 'bist' });
  }
  out.sort((a, b) => b.weight - a.weight);
  return out;
}


function walkJson(value, visitor, path = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkJson(v, visitor, path.concat(String(i))));
    return;
  }
  if (value && typeof value === 'object') {
    visitor(value, path);
    Object.keys(value).forEach(k => walkJson(value[k], visitor, path.concat(k)));
  }
}

function parseDateAny(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number' && v > 1000000000) return v;
  const s = String(v || '').trim();
  if (!s) return 0;
  const t = Date.parse(s);
  if (Number.isFinite(t)) return t;
  const dm = s.match(/(\d{1,2})[\.\/\-](\d{1,2})[\.\/\-](\d{2,4})/);
  if (dm) {
    const y = Number(dm[3].length === 2 ? '20' + dm[3] : dm[3]);
    const m = Number(dm[2]);
    const d = Number(dm[1]);
    const dt = Date.UTC(y, m - 1, d);
    return Number.isFinite(dt) ? dt : 0;
  }
  return 0;
}

function extractChartPriceFromJson(data, fundCode) {
  const candidates = [];
  const priceKeys = /(^|_)(price|fiyat|deger|value|close|kapanis|kapanış|paydegeri|pay_degeri|son)($|_)/i;
  const dateKeys = /(date|tarih|time|zaman|created|gun|gün)/i;

  function addCandidate(obj, key, rawPrice) {
    const price = toNumber(rawPrice);
    if (!Number.isFinite(price) || price <= 0 || price > 100000) return;
    let dateRaw = '';
    let dateScore = 0;
    Object.keys(obj || {}).forEach(k => {
      if (!dateKeys.test(k)) return;
      const score = parseDateAny(obj[k]);
      if (score >= dateScore) { dateScore = score; dateRaw = obj[k]; }
    });
    candidates.push({ price, key, raw: rawPrice, dateRaw, dateScore });
  }

  walkJson(data, (obj) => {
    Object.keys(obj || {}).forEach(k => {
      if (priceKeys.test(k)) addCandidate(obj, k, obj[k]);
    });
    // Bazı servislerde veri dizi halinde [tarih, fiyat] / [timestamp, fiyat] gelebilir.
    Object.keys(obj || {}).forEach(k => {
      const v = obj[k];
      if (Array.isArray(v)) {
        v.forEach(row => {
          if (Array.isArray(row) && row.length >= 2) {
            const d0 = parseDateAny(row[0]);
            const p1 = toNumber(row[1]);
            if (d0 && Number.isFinite(p1) && p1 > 0) {
              candidates.push({ price: p1, key: 'array[1]', raw: row[1], dateRaw: row[0], dateScore: d0 });
            }
          }
        });
      }
    });
  });

  candidates.sort((a, b) => (b.dateScore || 0) - (a.dateScore || 0) || b.price - a.price);
  const best = candidates[0];
  if (!best) return null;
  return {
    price: Number(best.price.toFixed(6)),
    date: best.dateScore ? new Date(best.dateScore).toISOString().slice(0,10) : '',
    method: 'api-getFonChartPrice-json-' + best.key,
    raw: String(best.raw),
    candidateCount: candidates.length
  };
}

async function loadChartPriceInfo(code, attempts) {
  const url = `https://api.ekofin.net/AppUseFinancialService/AppUseFinancials/getFonChartPrice?fon_kodu=${encodeURIComponent(code)}`;
  try {
    const r = await httpsGet(url, 18000, {
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://ekofin.net',
      'Referer': 'https://ekofin.net/'
    });
    const rec = { step: 'getFonChartPrice', url, status: r.status, contentType: r.headers['content-type'] || '', len: (r.body || '').length };
    attempts.push(rec);
    if (r.status < 200 || r.status >= 300) return null;
    let data = null;
    try { data = JSON.parse(r.body || 'null'); } catch (e) { rec.error = 'JSON parse failed: ' + e.message; return null; }
    const found = extractChartPriceFromJson(data, code);
    rec.parsed = !!found;
    if (found) {
      rec.price = found.price;
      rec.method = found.method;
      rec.candidateCount = found.candidateCount;
      return {
        name: code,
        price: found.price,
        dailyReturn: 0,
        weeklyReturn: 0,
        monthlyReturn: 0,
        size: 0,
        investors: 0,
        date: found.date || '',
        priceSource: 'EKOFIN',
        priceMethod: found.method,
        priceRaw: found.raw
      };
    }
  } catch (err) {
    attempts.push({ step: 'getFonChartPrice', url, error: err && err.message ? err.message : String(err) });
  }
  return null;
}

function extractPriceInfo(html, fundCode) {
  const rawHtml = String(html || '');
  const text = stripTags(rawHtml);
  const info = {
    name: fundCode,
    price: 0,
    dailyReturn: 0,
    weeklyReturn: 0,
    monthlyReturn: 0,
    size: 0,
    investors: 0,
    date: extractDate(html),
    priceSource: '',
    priceMethod: '',
    priceRaw: ''
  };

  const titleRe = new RegExp('\\b' + fundCode + '\\b\\s*[-–—]?\\s*([^|]{8,160}?)(?:Fon Fiyat|Günlük|Portföy|Yatırımcı|$)', 'i');
  const tm = text.match(titleRe);
  if (tm && tm[1]) info.name = (fundCode + ' ' + tm[1]).replace(/\s+/g, ' ').trim().slice(0, 180);

  // Kullanıcının inspect ile gönderdiği gerçek Ekofin fiyat bloğu örneği:
  // <span>7277.9040<!-- -->TL</span><span class="text-sm text-green-600">(<!-- -->0.27<!-- -->%)</span>
  // Ekofin/Next.js HTML'inde araya <!-- --> yorumları girebildiği için önce ham HTML üzerinde yakalıyoruz.
  const htmlPricePatterns = [
    /<span[^>]*>\s*([0-9]+[\.,][0-9]{3,8})\s*(?:<!--\s*-->)?\s*(?:TL|₺)\s*<\/span>/i,
    />\s*([0-9]+[\.,][0-9]{3,8})\s*(?:<!--\s*-->)?\s*(?:TL|₺)\s*</i
  ];
  for (const re of htmlPricePatterns) {
    const m = rawHtml.match(re);
    if (m) {
      const n = toNumber(m[1]);
      if (Number.isFinite(n) && n > 0 && n < 100000) {
        info.price = n;
        info.priceSource = 'EKOFIN';
        info.priceMethod = 'summary-html-span-tl';
        info.priceRaw = m[0].replace(/\s+/g, ' ').slice(0, 180);
        break;
      }
    }
  }

  // Aynı görsel blokta fiyatın hemen yanında günlük değişim yüzdesi bulunur.
  // Örn: <span>7277.9040<!-- -->TL</span><span class="text-sm text-green-600">(<!-- -->0.27<!-- -->%)</span>
  if (info.price) {
    const priceIdx = rawHtml.indexOf(info.priceRaw && info.priceRaw.slice(0, 20));
    const near = priceIdx >= 0 ? rawHtml.slice(priceIdx, priceIdx + 500) : rawHtml;
    const pm = near.match(/\(\s*(?:<!--\s*-->)?\s*(-?\d+(?:[\.,]\d+)?)\s*(?:<!--\s*-->)?\s*%\s*\)/i) || near.match(/(-?\d+(?:[\.,]\d+)?)\s*(?:<!--\s*-->)?\s*%/i);
    if (pm) {
      const dn = toNumber(pm[1]);
      if (Number.isFinite(dn) && Math.abs(dn) < 100) info.dailyReturn = dn;
    }
  }

  if (!info.price) {
    const pricePatterns = [
      /(?:Fon\s*Fiyatı|Birim\s*Pay\s*Değeri|Son\s*Fiyat|Fiyat)\s*[:：]?\s*([0-9]+[\.,][0-9]{3,8})/i,
      /([0-9]+[\.,][0-9]{4,8})\s*(?:TL|₺)\b/i
    ];
    for (const re of pricePatterns) {
      const m = text.match(re);
      if (m) {
        const n = toNumber(m[1]);
        if (Number.isFinite(n) && n > 0 && n < 100000) {
          info.price = n;
          info.priceSource = 'EKOFIN';
          info.priceMethod = 'summary-text-tl';
          info.priceRaw = m[0].replace(/\s+/g, ' ').slice(0, 180);
          break;
        }
      }
    }
  }

  function pctNear(re) {
    const idx = text.search(re);
    if (idx < 0) return 0;
    const m = text.slice(idx, idx + 260).match(/(-?\d+[\.,]\d+)\s*%/);
    return m ? toNumber(m[1]) : 0;
  }
  info.dailyReturn = pctNear(/Günlük|1\s*Gün/i);
  info.weeklyReturn = pctNear(/Haftalık|1\s*Hafta/i);
  info.monthlyReturn = pctNear(/Aylık|1\s*Ay/i);
  return (info.price > 0 || info.dailyReturn || info.weeklyReturn || info.monthlyReturn) ? info : null;
}

function historicalUrls(code) {
  const c = encodeURIComponent(code);
  return [
    `https://ekofin.net/fonlar/detay/${c}/historical-distribution?fonKodu=${c}`,
    `https://ekofin.net/fonlar/detay/${c}/fon-portfoy/historical-distribution?fonKodu=${c}`,
    `https://ekofin.net/historical-distribution?fonKodu=${c}`,
    `https://ekofin.net/api/historical-distribution?fonKodu=${c}`
  ];
}

async function loadHistoricalPortfolio(code, attempts) {
  for (const url of historicalUrls(code)) {
    try {
      const r = await httpsGet(url, 12000);
      attempts.push({ step: 'historical-distribution', url, status: r.status, contentType: r.headers['content-type'] || '', len: (r.body || '').length });
      if (r.status < 200 || r.status >= 300) continue;
      const rows = rowsFromJsonText(r.body);
      const holdings = normalizeHistoricalRows(rows, code);
      attempts[attempts.length - 1].rows = rows.length;
      attempts[attempts.length - 1].parsed = holdings.length;
      if (holdings.length) return holdings;
    } catch (err) {
      attempts.push({ step: 'historical-distribution', url, error: err && err.message ? err.message : String(err) });
    }
  }
  return [];
}

async function loadHtmlPortfolio(code, attempts) {
  const url = `https://ekofin.net/fonlar/detay/${encodeURIComponent(code)}/fon-portfoy`;
  try {
    const r = await httpsGet(url, 18000);
    attempts.push({ step: 'fon-portfoy', url, status: r.status, contentType: r.headers['content-type'] || '', len: (r.body || '').length });
    if (r.status < 200 || r.status >= 300) return [];
    const holdings = extractAnchorHoldings(r.body, code, 'portfolio');
    attempts[attempts.length - 1].parsed = holdings.length;
    return holdings;
  } catch (err) {
    attempts.push({ step: 'fon-portfoy', url, error: err && err.message ? err.message : String(err) });
    return [];
  }
}

async function loadCarriedFunds(code, attempts) {
  const url = `https://ekofin.net/fonlar/detay/${encodeURIComponent(code)}/tasinan-fonlar`;
  try {
    const r = await httpsGet(url, 18000);
    attempts.push({ step: 'tasinan-fonlar', url, status: r.status, contentType: r.headers['content-type'] || '', len: (r.body || '').length });
    if (r.status < 200 || r.status >= 300) return [];
    const holdings = extractAnchorHoldings(r.body, code, 'carried');
    attempts[attempts.length - 1].parsed = holdings.length;
    return holdings;
  } catch (err) {
    attempts.push({ step: 'tasinan-fonlar', url, error: err && err.message ? err.message : String(err) });
    return [];
  }
}

async function loadSummaryInfo(code, attempts) {
  // ORKA v22: Birincil fiyat kaynağı artık kullanıcının ekranda gördüğü Ekofin özet kartıdır.
  // Amaç: sol üstte görünen "7277.9040 TL (0.27%)" bloğunu okumak.
  // Portföy/ağırlık okuyucularına dokunulmadı. Chart JSON sadece yedek kalır.
  const url = `https://ekofin.net/fonlar/detay/${encodeURIComponent(code)}`;
  let htmlInfo = null;
  let date = '';
  try {
    const r = await httpsGet(url, 18000);
    attempts.push({ step: 'summary-visual-card', url, status: r.status, contentType: r.headers['content-type'] || '', len: (r.body || '').length });
    if (r.status >= 200 && r.status < 300) {
      htmlInfo = extractPriceInfo(r.body, code);
      attempts[attempts.length - 1].hasInfo = !!htmlInfo;
      if (htmlInfo) attempts[attempts.length - 1].price = htmlInfo.price;
      date = extractDate(r.body) || (htmlInfo ? htmlInfo.date : '');
      if (htmlInfo && htmlInfo.price > 0) {
        htmlInfo.date = date || htmlInfo.date || '';
        htmlInfo.priceSource = 'EKOFIN';
        htmlInfo.priceMethod = htmlInfo.priceMethod || 'summary-visual-card';
        return { info: htmlInfo, date: htmlInfo.date || date || '' };
      }
    }
  } catch (err) {
    attempts.push({ step: 'summary-visual-card', url, error: err && err.message ? err.message : String(err) });
  }

  // Yedek: Ekofin chart JSON. Bu da olmazsa fiyat boş döner; portföy okuma etkilenmez.
  const chartInfo = await loadChartPriceInfo(code, attempts);
  if (chartInfo) {
    if (htmlInfo) {
      chartInfo.name = htmlInfo.name || chartInfo.name || code;
      chartInfo.dailyReturn = htmlInfo.dailyReturn || chartInfo.dailyReturn || 0;
      chartInfo.weeklyReturn = htmlInfo.weeklyReturn || 0;
      chartInfo.monthlyReturn = htmlInfo.monthlyReturn || 0;
    }
    return { info: chartInfo, date: chartInfo.date || date || '' };
  }
  return { info: htmlInfo, date: (htmlInfo && htmlInfo.date) || date || '' };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Only GET is supported' });

  const code = cleanCode((req.query && (req.query.code || req.query.kod || req.query.fon || req.query.fonKodu)) || '');
  const debug = String((req.query && req.query.debug) || '') === '1';
  if (!code) return res.status(400).json({ ok: false, error: 'Missing code parameter' });

  const attempts = [];
  const mode = String((req.query && req.query.mode) || '').toLowerCase();

  // Her parça bağımsızdır; biri hata verirse diğerini düşürmez.
  const summary = await loadSummaryInfo(code, attempts);
  let portfolio = [];
  let carried = [];

  if (mode !== 'info') {
    portfolio = await loadHistoricalPortfolio(code, attempts);
    if (!portfolio.length) portfolio = await loadHtmlPortfolio(code, attempts);
    carried = await loadCarriedFunds(code, attempts);
  }

  const holdings = mergeHoldings(portfolio, carried);
  const used = [];
  if (portfolio.length) used.push('portfolio');
  if (carried.length) used.push('tasinan-fonlar');

  const payload = {
    ok: !!(summary.info || holdings.length),
    source: used.length ? 'ekofin' : 'ekofin-info',
    sourceMessage: carried.length ? 'Taşınan fonlar Ekofin /tasinan-fonlar sayfasından eklendi.' : '',
    code,
    count: holdings.length,
    latestDate: summary.date || '',
    aciklamaTarihi: summary.date || '',
    info: summary.info || undefined,
    price: summary.info ? summary.info.price : undefined,
    priceSource: summary.info ? (summary.info.priceSource || 'EKOFIN') : undefined,
    priceMethod: summary.info ? (summary.info.priceMethod || '') : undefined,
    priceRaw: summary.info ? (summary.info.priceRaw || '') : undefined,
    dailyReturn: summary.info ? summary.info.dailyReturn : undefined,
    holdings
  };

  if (!payload.ok) payload.error = 'Ekofin verisi okunamadı';
  if (debug) payload.debug = { mode, used, attempts, sample: holdings.slice(0, 10), info: summary.info || null };

  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
  return res.status(200).json(payload);
}
