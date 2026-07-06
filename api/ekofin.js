// Vercel Serverless Function: /api/ekofin?code=TLY
// Ekofin fon-portföy sayfasını sunucu tarafında okur ve HTML'e temiz JSON döndürür.
// Not: Node 16/18 uyumu için global fetch yerine https modülü kullanır.

const https = require('https');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

function cleanCode(code) {
  return String(code || '').toUpperCase().trim().replace(/[^A-Z0-9]/g, '');
}

function trNumber(value) {
  if (value === null || value === undefined) return NaN;
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

function decodeHtml(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\\u003c/gi, '<')
    .replace(/\\u003e/gi, '>')
    .replace(/\\u0026/gi, '&');
}

function htmlToText(html) {
  return decodeHtml(String(html || ''))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.7,en;q=0.6',
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

function normalizeHolding(raw, fundCode, seen, holdings) {
  const code = cleanCode(raw.code || raw.kod || raw.symbol || raw.sembol || raw.varlik || raw.hisseKodu || raw.assetCode || raw.name);
  if (!code || code === fundCode || seen.has(code)) return;

  let weight = raw.weight;
  if (weight === undefined) weight = raw.agirlik;
  if (weight === undefined) weight = raw.ağırlık;
  if (weight === undefined) weight = raw.oran;
  if (weight === undefined) weight = raw.percentage;
  if (weight === undefined) weight = raw.agirlikYuzde;
  if (weight === undefined) weight = raw.portfoyOrani;
  if (weight === undefined) weight = raw.portföyOrani;

  weight = trNumber(weight);
  if (!Number.isFinite(weight) || Math.abs(weight) < 0.005 || Math.abs(weight) > 100) return;

  seen.add(code);
  holdings.push({
    code,
    symbol: code,
    name: raw.name || raw.ad || raw.title || raw.varlikAdi || raw.varlıkAdi || code,
    weight: Number(weight.toFixed(4)),
    type: raw.type || raw.tip || 'bist'
  });
}

function walkJson(value, fundCode, seen, holdings, depth = 0) {
  if (!value || depth > 12) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') {
        const hasCode = item.code || item.kod || item.symbol || item.sembol || item.varlik || item.hisseKodu || item.assetCode;
        const hasWeight = item.weight !== undefined || item.agirlik !== undefined || item.ağırlık !== undefined || item.oran !== undefined || item.percentage !== undefined || item.agirlikYuzde !== undefined || item.portfoyOrani !== undefined;
        if (hasCode && hasWeight) normalizeHolding(item, fundCode, seen, holdings);
        walkJson(item, fundCode, seen, holdings, depth + 1);
      }
    }
    return;
  }
  if (typeof value === 'object') {
    for (const k of Object.keys(value)) walkJson(value[k], fundCode, seen, holdings, depth + 1);
  }
}

function parseNextData(html, fundCode) {
  const holdings = [];
  const seen = new Set();
  const scripts = [];
  const nextMatch = String(html || '').match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextMatch) scripts.push(nextMatch[1]);

  const jsonScriptRegex = /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = jsonScriptRegex.exec(html)) !== null) scripts.push(m[1]);

  for (const raw of scripts) {
    try {
      const data = JSON.parse(decodeHtml(raw));
      walkJson(data, fundCode, seen, holdings);
    } catch (_) {}
  }
  return holdings;
}

function parseTextRows(html, fundCode) {
  const text = htmlToText(html);
  const holdings = [];
  const seen = new Set();

  let area = text;
  const idx = area.search(/Güncel\s+Portföy|Portföy\s+Dağılımı|Fon\s+Portföy/i);
  if (idx >= 0) area = area.slice(idx);
  area = area.split(/Artırılan Pozisyonlar|Azaltılan Pozisyonlar|Sıkça Sorulan Sorular|Fonun Diğer Bilgileri|Yorumlar/i)[0] || area;

  // Ekofin satırları çoğunlukla: KOD fiyat günlük% ağırlık%
  // Tek satıra yığılmış HTML için her KOD + sayı başlangıcına satır kırıyoruz.
  const chunks = area
    .replace(/([A-Z0-9]{2,12})\s+(?=\d+[\.,]?\d*)/g, '\n$1 ')
    .split(/\n|\r/)
    .map(s => s.trim())
    .filter(Boolean);

  for (const line of chunks) {
    const codeMatch = line.match(/^([A-Z0-9]{2,12})\b/);
    if (!codeMatch) continue;
    const code = cleanCode(codeMatch[1]);
    if (!code || code === fundCode || seen.has(code)) continue;

    const pcts = [];
    line.replace(/(-?\d+(?:[\.,]\d+)?)\s*%/g, (_, n) => { pcts.push(n); return _; });
    if (!pcts.length) continue;

    const weight = trNumber(pcts[pcts.length - 1]);
    if (!Number.isFinite(weight) || Math.abs(weight) < 0.005 || Math.abs(weight) > 100) continue;

    seen.add(code);
    holdings.push({ code, symbol: code, name: code, weight: Number(weight.toFixed(4)), type: 'bist' });
  }

  return holdings;
}

function parseEkofin(html, fundCode) {
  let holdings = parseNextData(html, fundCode);
  if (!holdings.length) holdings = parseTextRows(html, fundCode);

  const dateText = htmlToText(html);
  const dateMatch = dateText.match(/veriler\s+([^\.\n]+? tarihinde)\s+yay/i) || dateText.match(/(\d{1,2}[\.\/]\d{1,2}[\.\/]\d{4})/);

  holdings.sort((a, b) => b.weight - a.weight);
  return {
    ok: holdings.length > 0,
    source: 'ekofin',
    code: fundCode,
    count: holdings.length,
    aciklamaTarihi: dateMatch ? String(dateMatch[1]).trim() : '',
    holdings
  };
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Only GET is supported' });

  const code = cleanCode((req.query && (req.query.code || req.query.kod || req.query.fon)) || '');
  if (!code) return res.status(400).json({ ok: false, error: 'Missing code parameter' });

  const debug = String((req.query && req.query.debug) || '') === '1';
  const url = `https://ekofin.net/fonlar/detay/${encodeURIComponent(code)}/fon-portfoy`;

  try {
    const upstream = await httpsGet(url);
    const html = upstream.body || '';

    if (upstream.status < 200 || upstream.status >= 300) {
      return res.status(200).json({
        ok: false,
        source: 'ekofin',
        code,
        status: upstream.status,
        error: 'Ekofin HTTP error',
        url,
        sample: debug ? htmlToText(html).slice(0, 1000) : undefined
      });
    }

    const parsed = parseEkofin(html, code);
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');

    if (!parsed.ok) {
      return res.status(200).json({
        ...parsed,
        error: 'Ekofin portfolio not parsed',
        url,
        sample: htmlToText(html).slice(0, debug ? 1500 : 500)
      });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    // Önemli: Burada 500 dönmüyoruz. HTML tarafı gerçek hata mesajını okuyabilsin diye 200 + ok:false dönüyoruz.
    return res.status(200).json({
      ok: false,
      source: 'ekofin',
      code,
      error: err && err.message ? err.message : String(err),
      url
    });
  }
};
