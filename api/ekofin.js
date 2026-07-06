// Vercel Serverless Function: /api/ekofin?code=TLY
// Ekofin gerçek JSON kaynağı: historical-distribution?fonKodu=...
// HTML/RSC parse YOK. Sadece Ekofin'in sayfanın kendisinin kullandığı JSON endpoint'i okunur.

import https from 'node:https';

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
    .trim()
    .replace(/\s+/g, '');
  if (!x) return NaN;
  if (x.includes(',') && x.includes('.')) x = x.replace(/\./g, '').replace(',', '.');
  else x = x.replace(',', '.');
  return Number.parseFloat(x);
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        'Accept': 'application/json,text/plain,*/*',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.7,en;q=0.6',
        'Referer': 'https://ekofin.net/',
        'Cache-Control': 'no-cache'
      }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers || {}, body }));
    });
    req.on('timeout', () => req.destroy(new Error('Ekofin request timeout')));
    req.on('error', reject);
  });
}

function dateKey(row) {
  return String(row && (row.DONEM_TARIHI || row.donem_tarihi || row.donemTarihi || row.date || '') || '');
}

function normalizeRows(rows, fundCode) {
  if (!Array.isArray(rows)) return { latestDate: '', holdings: [], totalRows: 0 };

  const validRows = rows.filter(r => r && String(r.FON_KODU || r.fon_kodu || r.fonKodu || '').toUpperCase() === fundCode);
  const sourceRows = validRows.length ? validRows : rows.filter(r => r && (r.HISSE_ADI || r.hisse_adi || r.hisseAdi || r.code || r.symbol));

  const dates = sourceRows.map(dateKey).filter(Boolean).sort();
  const latestDate = dates.length ? dates[dates.length - 1] : '';
  const latestRows = latestDate ? sourceRows.filter(r => dateKey(r) === latestDate) : sourceRows;

  const seen = new Set();
  const holdings = [];

  for (const r of latestRows) {
    const code = cleanCode(r.HISSE_ADI || r.hisse_adi || r.hisseAdi || r.KOD || r.kod || r.code || r.symbol);
    if (!code || code === fundCode || seen.has(code)) continue;

    const weight = toNumber(r.PORTFOY_ORAN ?? r.portfoy_oran ?? r.portfoyOran ?? r.weight ?? r.agirlik ?? r.oran);
    if (!Number.isFinite(weight) || Math.abs(weight) < 0.005 || Math.abs(weight) > 100) continue;

    const rawType = String(r.TYPE || r.type || '').toUpperCase();
    let type = 'bist';
    if (rawType === 'FUND') type = 'fund';
    else if (rawType === 'CASH' || rawType === 'MONEY') type = 'cash';
    else if (rawType === 'STOCK' || rawType === 'EQUITY') type = 'bist';

    seen.add(code);
    holdings.push({
      code,
      symbol: code,
      name: code,
      weight: Number(weight.toFixed(4)),
      type,
      tip: type,
      nominal: toNumber(r.NOMINAL_DEGER ?? r.nominal_deger ?? r.nominalDeger),
      value: toNumber(r.TOPLAM_DEGER ?? r.toplam_deger ?? r.toplamDeger)
    });
  }

  holdings.sort((a, b) => b.weight - a.weight);
  return { latestDate, holdings, totalRows: rows.length };
}

function parseJsonBody(text) {
  const data = JSON.parse(text);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.result)) return data.result;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && data.data && Array.isArray(data.data.items)) return data.data.items;
  return [];
}

function endpointCandidates(code) {
  const c = encodeURIComponent(code);
  // DevTools'ta çalışan istek sayfa path'ine göre relatif geliyor:
  // /fonlar/detay/TLY/historical-distribution?fonKodu=TLY
  // Önce bunu deniyoruz; diğerleri sadece emniyet yedeği.
  return [
    `https://ekofin.net/fonlar/detay/${c}/historical-distribution?fonKodu=${c}`,
    `https://ekofin.net/fonlar/detay/${c}/fon-portfoy/historical-distribution?fonKodu=${c}`,
    `https://ekofin.net/api/historical-distribution?fonKodu=${c}`,
    `https://ekofin.net/historical-distribution?fonKodu=${c}`
  ];
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Only GET is supported' });

  const code = cleanCode((req.query && (req.query.code || req.query.kod || req.query.fon || req.query.fonKodu)) || '');
  const debug = String((req.query && req.query.debug) || '') === '1';
  if (!code) return res.status(400).json({ ok: false, error: 'Missing code parameter' });

  const attempts = [];

  for (const url of endpointCandidates(code)) {
    try {
      const upstream = await httpsGet(url);
      attempts.push({ url, status: upstream.status, contentType: upstream.headers['content-type'] || '', len: (upstream.body || '').length });

      if (upstream.status < 200 || upstream.status >= 300) continue;

      let rows;
      try { rows = parseJsonBody(upstream.body || '[]'); }
      catch (e) {
        attempts[attempts.length - 1].jsonError = e.message;
        continue;
      }

      const normalized = normalizeRows(rows, code);
      const payload = {
        ok: normalized.holdings.length > 0,
        source: 'ekofin-historical-distribution',
        code,
        count: normalized.holdings.length,
        latestDate: normalized.latestDate,
        aciklamaTarihi: normalized.latestDate ? normalized.latestDate.slice(0, 10) : '',
        holdings: normalized.holdings
      };

      if (debug) {
        payload.debug = {
          endpoint: url,
          totalRows: normalized.totalRows,
          attempts,
          firstRows: Array.isArray(rows) ? rows.slice(0, 3) : []
        };
      }

      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
      return res.status(200).json(payload);
    } catch (err) {
      attempts.push({ url, error: err && err.message ? err.message : String(err) });
    }
  }

  return res.status(200).json({
    ok: false,
    source: 'ekofin-historical-distribution',
    code,
    error: 'Ekofin historical-distribution endpoint failed or returned empty data',
    attempts: debug ? attempts : undefined
  });
}
