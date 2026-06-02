// api/yahoo.js - Vercel
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const ticker = req.query.ticker;
  const range  = req.query.range || '1d';

  if (!ticker) {
    res.status(400).json({ error: 'ticker required' });
    return;
  }

  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/'
    + encodeURIComponent(ticker)
    + '?interval=1d&range=' + encodeURIComponent(range);

  try {
    let response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });

    if (!response.ok) {
      const url2 = url.replace('query1', 'query2');
      response = await fetch(url2, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    }

    if (!response.ok) {
      res.status(response.status).json({ error: 'Yahoo HTTP ' + response.status });
      return;
    }

    const data = await response.json();
    res.status(200).json(data);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
