export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const ticker = String(req.query.ticker || req.query.symbol || '').trim().toUpperCase();
    const range = String(req.query.range || '5d');
    const interval = String(req.query.interval || '1d');
    if (!ticker) return res.status(400).json({ ok: false, error: 'ticker required' });

    const yahooSymbol = normalizeYahooSymbol(ticker);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
    const r = await fetch(url, { headers: browserHeaders() });
    const text = await r.text();

    if (!r.ok) {
      return res.status(r.status).json({ ok: false, error: 'Yahoo request failed', status: r.status, body: text.slice(0, 400) });
    }

    let data;
    try { data = JSON.parse(text); } catch (e) { return res.status(502).json({ ok: false, error: 'Yahoo JSON parse failed' }); }

    const result = data?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0] || {};
    const meta = result?.meta || {};
    const closes = Array.isArray(quote.close) ? quote.close.filter(v => typeof v === 'number') : [];
    const price = typeof meta.regularMarketPrice === 'number' ? meta.regularMarketPrice : closes.at(-1);
    const prev = typeof meta.chartPreviousClose === 'number' ? meta.chartPreviousClose : closes.at(-2);

    return res.status(200).json({
      ok: true,
      ticker,
      symbol: yahooSymbol,
      price,
      previousClose: prev,
      currency: meta.currency || '',
      marketTime: meta.regularMarketTime || null,
      raw: data
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

function normalizeYahooSymbol(ticker) {
  if (!ticker) return ticker;
  if (ticker.includes('.') || ticker.includes('-') || ticker.includes('=')) return ticker;
  const bistLike = /^[A-Z]{3,6}$/.test(ticker) && !['SPCX','AAPL','MSFT','NVDA','TSLA','GOOG','GOOGL','AMZN','META'].includes(ticker);
  return bistLike ? `${ticker}.IS` : ticker;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept');
}

function browserHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    'Accept': 'application/json,text/plain,*/*',
    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7'
  };
}
