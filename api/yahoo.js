export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const ticker = (req.query && req.query.ticker) || '';
    const range = (req.query && req.query.range) || '5d';
    const interval = (req.query && req.query.interval) || '1d';
    if (!ticker) return res.status(400).json({ ok:false, error:'ticker required' });

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
    let r = await fetch(url, { headers: { 'User-Agent':'Mozilla/5.0', 'Accept':'application/json,text/plain,*/*' } });
    if (!r.ok) {
      const url2 = url.replace('query1.finance.yahoo.com', 'query2.finance.yahoo.com');
      r = await fetch(url2, { headers: { 'User-Agent':'Mozilla/5.0', 'Accept':'application/json,text/plain,*/*' } });
    }
    const txt = await r.text();
    res.status(r.status);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json; charset=utf-8');
    return res.send(txt);
  } catch(e) {
    return res.status(500).json({ ok:false, error:e && e.message ? e.message : String(e) });
  }
}