export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const code = String(req.query.code || req.query.kod || req.query.fon || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ ok: false, error: 'code required' });

  const attempts = [];
  const urls = candidateUrls(code);

  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: fvtHeaders(code), redirect: 'follow' });
      const text = await r.text();
      attempts.push({ url, status: r.status, len: text.length, contentType: r.headers.get('content-type') || '' });

      if (!r.ok || !text) continue;

      const parsed = parseFvtResponse(text, code, r.headers.get('content-type') || '');
      if (parsed.holdings.length > 0) {
        return res.status(200).json({
          ok: true,
          code,
          source: url,
          holdings: parsed.holdings,
          aciklamaTarihi: parsed.aciklamaTarihi || '',
          attempts
        });
      }
    } catch (e) {
      attempts.push({ url, error: e.message || String(e) });
    }
  }

  return res.status(502).json({
    ok: false,
    error: 'FVT portfolio data unavailable after recovery attempts',
    code,
    holdings: [],
    attempts
  });
}

function candidateUrls(code) {
  const c = encodeURIComponent(code);
  return [
    `https://fvt.com.tr/api/funds/${c}/distribution`,
    `https://fvt.com.tr/api/funds/${c}?include=distribution`,
    `https://fvt.com.tr/api/fon/${c}/distribution`,
    `https://fvt.com.tr/api/fonlar/${c}/distribution`,
    `https://fvt.com.tr/api/portfolio-distribution?code=${c}`,
    `https://fvt.com.tr/api/portfolio-distribution?kod=${c}`,
    `https://fvt.com.tr/api/fund/portfolio?code=${c}`,
    `https://fvt.com.tr/api/fund/portfolio?kod=${c}`,
    `https://fvt.com.tr/fon-detay/${c}`,
    `https://fvt.com.tr/fon/${c}`,
    `https://fvt.com.tr/fonlar/${c}`,
    `https://fvt.com.tr/yatirim-fonlari/${c}`,
    `https://fvt.com.tr/terminal/fon/${c}`
  ];
}

function parseFvtResponse(text, code, contentType) {
  const jsonCandidates = [];

  if (contentType.includes('json') || /^[\s\[{]/.test(text)) {
    try { jsonCandidates.push(JSON.parse(text)); } catch (_) {}
  }

  for (const m of text.matchAll(/<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { jsonCandidates.push(JSON.parse(htmlDecode(m[1].trim()))); } catch (_) {}
  }

  for (const m of text.matchAll(/__NEXT_DATA__[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { jsonCandidates.push(JSON.parse(htmlDecode(m[1].trim()))); } catch (_) {}
  }

  for (const obj of jsonCandidates) {
    const found = findHoldingArrays(obj);
    for (const arr of found) {
      const holdings = normalizeHoldings(arr);
      if (holdings.length > 0) return { holdings, aciklamaTarihi: findDate(obj) };
    }
  }

  const tableHoldings = parseHtmlTables(text);
  if (tableHoldings.length > 0) return { holdings: tableHoldings, aciklamaTarihi: '' };

  return { holdings: [], aciklamaTarihi: '' };
}

function findHoldingArrays(root) {
  const out = [];
  const seen = new Set();
  function walk(v, depth = 0) {
    if (!v || depth > 12) return;
    if (Array.isArray(v)) {
      if (v.length && v.some(looksLikeHolding)) out.push(v);
      return;
    }
    if (typeof v === 'object') {
      if (seen.has(v)) return;
      seen.add(v);
      for (const key of Object.keys(v)) {
        const lower = key.toLowerCase();
        const val = v[key];
        if (Array.isArray(val) && /(holding|portfoy|portfolio|distribution|dagilim|varlik|position|asset|items|data)/i.test(lower)) {
          if (val.some(looksLikeHolding)) out.push(val);
        }
        walk(val, depth + 1);
      }
    }
  }
  walk(root);
  return out.sort((a, b) => b.length - a.length);
}

function looksLikeHolding(x) {
  if (!x || typeof x !== 'object') return false;
  const keys = Object.keys(x).map(k => k.toLowerCase());
  const hasCode = keys.some(k => /(hisse|kod|code|symbol|varlik|asset|ticker|menkul)/.test(k));
  const hasWeight = keys.some(k => /(agirlik|ağırlık|weight|oran|percentage|yuzde|yüzde|ratio|pay)/.test(k));
  return hasCode && hasWeight;
}

function normalizeHoldings(arr) {
  return arr.map(it => {
    const code = firstString(it, ['hisseKodu','hisse_kodu','kod','code','assetCode','symbol','varlikKodu','varlıkKodu','ticker','menkulKodu']);
    const name = firstString(it, ['sirketAdi','şirketAdı','ad','name','assetName','varlikAdi','varlıkAdı','unvan','title']) || code;
    const weightRaw = firstValue(it, ['agirlik','ağırlık','weight','oran','agirlikYuzde','ağırlıkYüzde','percentage','yuzde','yüzde','ratio','pay']);
    const weight = parseNumber(weightRaw);
    if (!code || !Number.isFinite(weight) || Math.abs(weight) <= 0.01) return null;
    return { code: String(code).trim().toUpperCase(), name: String(name || code).trim(), weight, type: inferType(code, name, it) };
  }).filter(Boolean).sort((a, b) => b.weight - a.weight);
}

function parseHtmlTables(html) {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1]);
  const items = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => cleanHtml(m[1]));
    if (cells.length < 2) continue;
    const joined = cells.join(' ');
    const code = (joined.match(/\b[A-Z]{2,6}[A-Z0-9]{0,4}\b/) || [])[0];
    const pctCell = cells.find(c => /%|\d+[,.]\d+/.test(c));
    const weight = parseNumber(pctCell);
    if (code && Number.isFinite(weight) && weight > 0.01) items.push({ code, name: cells.find(c => c !== code && !/%/.test(c)) || code, weight, type: inferType(code, '', {}) });
  }
  return items.sort((a, b) => b.weight - a.weight);
}

function firstString(obj, keys) {
  const v = firstValue(obj, keys);
  return v == null ? '' : String(v).trim();
}

function firstValue(obj, keys) {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  const lower = Object.fromEntries(Object.keys(obj).map(k => [k.toLowerCase(), k]));
  for (const k of keys) {
    const real = lower[k.toLowerCase()];
    if (real && obj[real] !== undefined && obj[real] !== null && obj[real] !== '') return obj[real];
  }
  return undefined;
}

function parseNumber(v) {
  if (typeof v === 'number') return v;
  if (v == null) return NaN;
  let s = String(v).replace(/<[^>]+>/g, '').replace('%', '').trim();
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(',', '.');
  return parseFloat(s);
}

function inferType(code, name, raw) {
  const c = String(code || '').toUpperCase();
  const n = String(name || '').toUpperCase();
  const byf = ['GLDTRF','GMSTRF','ZPX3GF','ZPX30F','TPKGY','TPKGYF1','HMV','T3B','PKZ','PQS','PFS','ABG','TI1','RPP','CFO','RS1','PNU','PRY','CPU','PBR'];
  if (byf.includes(c)) return c.includes('TRF') ? 'cash' : 'fund';
  if (raw?.etf === true || raw?.etf === 1) return 'fund';
  if (raw?.yabanci === true || raw?.yabanci === 1 || /USD|NASDAQ|NYSE|US /.test(n)) return 'us';
  if (/TL|PARA PIYASASI|MEVDUAT|REPO|NAKIT|LİKİT|LIKIT/.test(n)) return 'cash';
  return 'bist';
}

function findDate(obj) {
  let found = '';
  function walk(v, depth = 0) {
    if (found || !v || depth > 8) return;
    if (typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (/tarih|date|aciklama|açıklama/i.test(k) && typeof val === 'string') { found = val; return; }
        walk(val, depth + 1);
      }
    }
  }
  walk(obj);
  return found;
}

function cleanHtml(s) { return htmlDecode(String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()); }
function htmlDecode(s) { return String(s).replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept');
}

function fvtHeaders(code) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    'Accept': 'application/json,text/html,text/plain,*/*',
    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': `https://fvt.com.tr/`,
    'Origin': 'https://fvt.com.tr'
  };
}
