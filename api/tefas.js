// api/tefas.js - Vercel TEFAS proxy
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    let endpoint = (req.query && req.query.endpoint) || null;
    let reqBody = {};

    if (req.method === 'POST') {
      let body = req.body || {};
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (_) { body = {}; }
      }
      endpoint = endpoint || body.endpoint;
      reqBody = body.body || body || {};
      delete reqBody.endpoint;
    } else {
      reqBody = { ...(req.query || {}) };
      delete reqBody.endpoint;
    }

    endpoint = endpoint || 'fonFiyatBilgiGetir';
    const allowed = new Set(['fonFiyatBilgiGetir', 'fonBilgiGetir']);
    if (!allowed.has(endpoint)) return res.status(400).json({ error: 'Unsupported TEFAS endpoint', endpoint });
    if (!reqBody.dil) reqBody.dil = 'TR';

    const target = 'https://www.tefas.gov.tr/api/funds/' + endpoint;
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Origin': 'https://www.tefas.gov.tr',
        'Referer': 'https://www.tefas.gov.tr/'
      },
      body: JSON.stringify(reqBody)
    });

    const txt = await response.text();
    res.status(response.status);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json; charset=utf-8');
    return res.send(txt);
  } catch (err) {
    return res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
}
