export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const endpoint = (req.query && req.query.endpoint) || 'fonFiyatBilgiGetir';
    const allowed = new Set(['fonFiyatBilgiGetir', 'fonBilgiGetir']);
    if (!allowed.has(endpoint)) {
      return res.status(400).json({ ok:false, error:'Unsupported TEFAS endpoint', endpoint });
    }

    let bodyObj = req.body || {};
    if (typeof bodyObj === 'string') {
      try { bodyObj = JSON.parse(bodyObj); } catch (_) { bodyObj = {}; }
    }
    if (!bodyObj || typeof bodyObj !== 'object') bodyObj = {};
    if (!bodyObj.dil) bodyObj.dil = 'TR';

    const r = await fetch(`https://www.tefas.gov.tr/api/funds/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0'
      },
      body: JSON.stringify(bodyObj)
    });

    const txt = await r.text();
    res.status(r.status);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json; charset=utf-8');
    return res.send(txt);
  } catch (e) {
    return res.status(500).json({ ok:false, error:e && e.message ? e.message : String(e) });
  }
}