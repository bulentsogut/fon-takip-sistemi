// Vercel Serverless Function: /api/yahoo?ticker=SPCX&interval=1d&range=1mo
// Robust Yahoo Finance chart proxy for ORKA / Hisse Takip

import https from 'node:https';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

function cleanTicker(v) {
  return String(v || '').trim().replace(/[^A-Za-z0-9.=-]/g, '');
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        'Accept': 'application/json,text/plain,*/*',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.7,en;q=0.6',
        'Cache-Control': 'no-cache'
      }
    }, (up) => {
      let body = '';
      up.setEncoding('utf8');
      up.on('data', c => { body += c; });
      up.on('end', () => {
        resolve({ status: up.statusCode || 0, headers: up.headers || {}, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Yahoo request timeout')));
    req.on('error', reject);
  });
}

function hasChartData(data) {
  const r = data && data.chart && data.chart.result && data.chart.result[0];
  const closes = r && r.indicators && r.indicators.adjclose && r.indicators.adjclose[0] && r.indicators.adjclose[0].adjclose;
  return !!(r && Array.isArray(closes) && closes.some(x => Number(x) > 0));
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Only GET is supported' });

  const ticker = cleanTicker(req.query.ticker || req.query.symbol);
  const interval = String(req.query.interval || '1d').trim();
  const range = String(req.query.range || '1mo').trim();
  const debug = String(req.query.debug || '') === '1';

  if (!ticker) return res.status(400).json({ ok: false, error: 'Missing ticker parameter' });

  const enc = encodeURIComponent(ticker);
  const qs = `interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}&includePrePost=false&events=div%2Csplits`;
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${enc}?${qs}`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${enc}?${qs}`
  ];

  const attempts = [];
  for (const url of urls) {
    try {
      const up = await httpsGetJson(url);
      attempts.push({ url, status: up.status, len: (up.body || '').length });
      if (up.status < 200 || up.status >= 300) continue;

      let data;
      try { data = JSON.parse(up.body || '{}'); }
      catch (e) { attempts[attempts.length - 1].jsonError = e.message; continue; }

      if (!hasChartData(data)) {
        attempts[attempts.length - 1].emptyChart = true;
        continue;
      }

      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (debug) data.__debug = { ok: true, ticker, attempts };
      return res.status(200).send(JSON.stringify(data));
    } catch (err) {
      attempts.push({ url, error: err && err.message ? err.message : String(err) });
    }
  }

  // 200 dönüyoruz ki index.html tarafında 404/500 yüzünden tüm akış kırılmasın;
  // ama chart.result boş olduğu için uygulama ilgili hisseyi başarısız sayar ve konsola yazar.
  return res.status(200).json({
    chart: { result: null, error: { code: 'NO_DATA', description: 'Yahoo data unavailable' } },
    ok: false,
    ticker,
    attempts: debug ? attempts : undefined
  });
}
