// Vercel Serverless Function: /api/fvt?code=TLY
//
// Gerçek FVT API'si (DevTools Network sekmesinden doğrulandı):
//   https://fvt.com.tr/api/funds/{KOD}/distribution
// Yanıt şekli: { success, data: { items: [...], meta: { aciklamaTarihi, ... } }, timestamp }
// Bu şekil, index.html içindeki loadFVTPortfolio() fonksiyonunun zaten
// beklediği `data.data.items` / `data.data.meta` yapısıyla birebir uyuşuyor,
// bu yüzden burada tek iş: gerçek endpoint'e gidip yanıtı olduğu gibi
// (CORS başlıklarıyla) tarayıcıya iletmek. Eski kod var olmayan onlarca
// URL'yi tahmin ederek deniyordu; hepsi kaldırıldı.

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept');
}

function cleanCode(code) {
  return String(code || '').toUpperCase().trim().replace(/[^A-Z0-9]/g, '');
}

function candidateUrls(code) {
  const c = encodeURIComponent(code);
  return [
    `https://fvt.com.tr/api/funds/${c}/distribution`,
    `https://www.fvt.com.tr/api/funds/${c}/distribution` // yedek (www ile)
  ];
}

function fvtHeaders(code) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.7,en;q=0.6',
    'Referer': `https://fvt.com.tr/fonlar/yatirim-fonlari/${encodeURIComponent(code)}`,
    'Origin': 'https://fvt.com.tr'
  };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Only GET is supported' });

  const code = cleanCode((req.query && (req.query.code || req.query.kod || req.query.fon)) || '');
  const debug = String((req.query && req.query.debug) || '') === '1';
  if (!code) return res.status(400).json({ ok: false, error: 'Missing code parameter' });

  const attempts = [];

  for (const url of candidateUrls(code)) {
    try {
      const upstream = await fetch(url, { headers: fvtHeaders(code) });
      const text = await upstream.text();
      attempts.push({ url, status: upstream.status, len: text.length });

      if (!upstream.ok) continue;

      let data;
      try { data = JSON.parse(text); }
      catch (e) {
        attempts[attempts.length - 1].jsonError = e.message;
        continue;
      }

      const items = (data && data.data && Array.isArray(data.data.items)) ? data.data.items : [];
      if (!items.length) {
        attempts[attempts.length - 1].parsed = 0;
        continue;
      }

      const payload = {
        ok: true,
        code,
        source: url,
        success: data.success,
        data: data.data,       // items + meta -> client tarafı doğrudan bunu bekliyor
        timestamp: data.timestamp
      };
      if (debug) payload.debug = { attempts };

      res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
      return res.status(200).json(payload);
    } catch (err) {
      attempts.push({ url, error: err && err.message ? err.message : String(err) });
    }
  }

  return res.status(200).json({
    ok: false,
    code,
    error: 'FVT distribution endpoint failed or returned empty data',
    attempts: debug ? attempts : undefined
  });
}
