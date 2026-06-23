export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const code = String((req.query && (req.query.code || req.query.fund || req.query.kod || req.query.fon)) || '').trim().toUpperCase();
  const type = String((req.query && (req.query.type || req.query.istek)) || 'distribution').trim();
  if (!code) return res.status(400).json({ ok:false, error:'code/fon required' });

  const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept': 'application/json,text/plain,*/*',
    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
  };

  function cookieFrom(headers) {
    try {
      const sc = headers.get('set-cookie') || '';
      if (!sc) return '';
      return sc.split(/,(?=[^;]+?=)/).map(x => x.split(';')[0].trim()).filter(Boolean).join('; ');
    } catch (_) { return ''; }
  }

  async function getSessionCookie() {
    const urls = [
      `https://fvt.com.tr/fonlar/yatirim-fonlari/${encodeURIComponent(code)}`,
      `https://fvt.com.tr/fonlar`,
      `https://fvt.com.tr/`
    ];
    let jar = '';
    for (const u of urls) {
      try {
        const r = await fetch(u, { headers: { ...baseHeaders, 'Accept':'text/html,*/*' }, redirect:'follow' });
        const c = cookieFrom(r.headers);
        if (c) jar = jar ? (jar + '; ' + c) : c;
      } catch (_) {}
    }
    return jar;
  }

  function normalizeItems(items, source) {
    if (!Array.isArray(items)) return [];
    const byf = new Set(['GLDTRF','GMSTRF','ZPX3GF','ZPX30F','TPKGY','TPKGYF1']);
    return items.map(it => {
      if (!it || typeof it !== 'object') return null;
      const kod = String(it.hisseKodu || it.kod || it.code || it.assetCode || it.symbol || it.varlikKodu || it.varlik || '').trim().toUpperCase();
      const ad = String(it.sirketAdi || it.ad || it.name || it.assetName || it.varlikAdi || kod || '').trim();
      let w = it.agirlik;
      if (w === undefined) w = it.weight;
      if (w === undefined) w = it.oran;
      if (w === undefined) w = it.agirlikYuzde;
      if (w === undefined) w = it.percentage;
      if (typeof w === 'string') w = w.replace('%','').replace(',', '.').trim();
      const agirlik = parseFloat(w);
      if (!kod || !isFinite(agirlik) || Math.abs(agirlik) <= 0.01) return null;
      let tip = it.type || it.tip;
      if (!tip) {
        if (byf.has(kod)) tip = 'cash';
        else if (it.etf === 1 || it.etf === true) tip = 'fund';
        else if (it.yabanci === 1 || it.yabanci === true) tip = 'us';
        else if (ad === '' && (it.yabanci === 0 || it.yabanci === false)) tip = 'fund';
        else tip = 'bist';
      }
      return { code:kod, kod, name:ad || kod, ad:ad || kod, weight:agirlik, agirlik, type:tip, tip, source };
    }).filter(Boolean).sort((a,b) => b.weight - a.weight);
  }

  function extractItemsFromJson(data) {
    if (!data) return [];
    const candidates = [
      data.holdings,
      data.items,
      data.distribution,
      data.positions,
      data.portfolio,
      data.data && data.data.holdings,
      data.data && data.data.items,
      data.data && data.data.distribution,
      data.data && data.data.positions,
      data.data && data.data.portfolio,
      Array.isArray(data) ? data : null
    ];
    for (const arr of candidates) {
      const norm = normalizeItems(arr, 'json');
      if (norm.length) return norm;
    }
    return [];
  }

  function extractJsonObjectsFromHtml(html) {
    const out = [];
    // __NEXT_DATA__ / Nuxt / serialized JSON blocks
    const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = scriptRe.exec(html))) {
      const s = (m[1] || '').trim();
      if (!s) continue;
      if (s.startsWith('{') || s.startsWith('[')) {
        try { out.push(JSON.parse(s)); } catch (_) {}
      }
      const next = s.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
      if (next) { try { out.push(JSON.parse(next[1])); } catch (_) {} }
    }
    const nextData = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (nextData) { try { out.push(JSON.parse(nextData[1])); } catch (_) {} }
    return out;
  }

  function walkFindHoldings(obj, depth = 0) {
    if (!obj || depth > 8) return [];
    if (Array.isArray(obj)) {
      const norm = normalizeItems(obj, 'walk');
      if (norm.length >= 2) return norm;
      for (const x of obj) {
        const r = walkFindHoldings(x, depth + 1);
        if (r.length) return r;
      }
      return [];
    }
    if (typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        const r = walkFindHoldings(obj[k], depth + 1);
        if (r.length) return r;
      }
    }
    return [];
  }

  function parseVisibleArchiveHtml(html) {
    // Arşiv sayfası plain-text olarak listelenebiliyor: KOD / ad / - / - / Ağırlık / Önceki / Fark
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, '\n')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\r/g, '\n');
    const lines = text.split(/\n+/).map(x => x.trim()).filter(Boolean);
    const out = [];
    const codeRe = /^[A-Z0-9]{2,8}$/;
    for (let i = 0; i < lines.length; i++) {
      const kod = lines[i].toUpperCase();
      if (!codeRe.test(kod)) continue;
      // nearby numeric values; choose first reasonable weight after two '-' markers or first 0-100 number.
      const window = lines.slice(i+1, i+10);
      const nums = window
        .map(x => x.replace('%','').replace(',', '.'))
        .filter(x => /^-?\d+(\.\d+)?$/.test(x))
        .map(Number)
        .filter(n => isFinite(n) && Math.abs(n) <= 100);
      if (!nums.length) continue;
      const weight = nums[0];
      if (Math.abs(weight) <= 0.01) continue;
      const name = window.find(x => x && !/^[-–—]$/.test(x) && !/^-?\d+([.,]\d+)?%?$/.test(x)) || kod;
      out.push({code:kod,kod,name,ad:name,weight,agirlik:weight,type:'bist',tip:'bist',source:'archive-html'});
    }
    // de-duplicate
    const seen = new Set();
    return out.filter(x => {
      if (seen.has(x.code)) return false;
      seen.add(x.code);
      return true;
    }).sort((a,b)=>b.weight-a.weight);
  }

  async function tryJson(url, headers) {
    const r = await fetch(url, { headers, redirect:'follow' });
    const txt = await r.text();
    let data = null;
    try { data = JSON.parse(txt); } catch (_) {}
    return { status:r.status, ok:r.ok, txt, data, url };
  }

  try {
    const jar = await getSessionCookie();
    const headerVariants = [
      { ...baseHeaders, ...(jar ? {'Cookie': jar} : {}) },
      { ...baseHeaders, 'Referer':'https://fvt.com.tr/', ...(jar ? {'Cookie': jar} : {}) },
      { ...baseHeaders, 'Referer':`https://fvt.com.tr/fonlar/yatirim-fonlari/${code}`, ...(jar ? {'Cookie': jar} : {}) },
      { ...baseHeaders, 'X-Requested-With':'XMLHttpRequest', ...(jar ? {'Cookie': jar} : {}) },
      { ...baseHeaders, 'Origin':'https://fvt.com.tr', 'Referer':'https://fvt.com.tr/', ...(jar ? {'Cookie': jar} : {}) }
    ];

    const apiUrls = [
      `https://fvt.com.tr/api/funds/${code}/distribution`,
      `https://fvt.com.tr/api/funds/${code}?include=distribution`,
      `https://fvt.com.tr/api/funds/${code}`,
      `https://fvt.com.tr/api/funds/${code}/portfolio`,
      `https://fvt.com.tr/api/funds/${code}/holdings`,
      `https://fvt.com.tr/api/funds/${code}/positions`,
      `https://fvt.com.tr/api/fund/${code}/distribution`,
      `https://fvt.com.tr/api/fund-distribution/${code}`,
      `https://fvt.com.tr/api/funds/distribution/${code}`,
      `https://fvt.com.tr/api/portfolio/fund/${code}`,
      `https://fvt.com.tr/api/portfolios/funds/${code}`
    ];

    const attempts = [];

    for (const url of apiUrls) {
      for (const headers of headerVariants) {
        try {
          const rr = await tryJson(url, headers);
          attempts.push({ url, status:rr.status, len:rr.txt ? rr.txt.length : 0 });
          const holdings = extractItemsFromJson(rr.data);
          if (holdings.length) {
            return res.status(200).json({
              ok:true, fon:code, source:url, holdings,
              aciklamaTarihi:(rr.data && rr.data.data && rr.data.data.meta && rr.data.data.meta.aciklamaTarihi) || '',
              toplamAgirlik:holdings.reduce((s,h)=>s+h.weight,0),
              attempts
            });
          }
        } catch(e) {
          attempts.push({ url, status:'ERR', error:e.message });
        }
      }
    }

    // Public page / serialized JSON fallback
    const pageUrls = [
      `https://fvt.com.tr/fonlar/yatirim-fonlari/${code}`,
      `https://arsiv.fvt.com.tr/yatirim-fonlari/${code.toLowerCase()}/`,
      `https://arsiv.fvt.com.tr/yatirim-fonlari/${code.toLowerCase()}`
    ];

    for (const url of pageUrls) {
      try {
        const r = await fetch(url, { headers: { ...baseHeaders, 'Accept':'text/html,*/*', ...(jar ? {'Cookie':jar} : {}) }, redirect:'follow' });
        const html = await r.text();
        attempts.push({ url, status:r.status, len:html.length });
        const objs = extractJsonObjectsFromHtml(html);
        for (const obj of objs) {
          const holdings = walkFindHoldings(obj);
          if (holdings.length) {
            return res.status(200).json({ ok:true, fon:code, source:url, holdings, toplamAgirlik:holdings.reduce((s,h)=>s+h.weight,0), attempts });
          }
        }
        const visible = parseVisibleArchiveHtml(html);
        if (visible.length >= 2) {
          return res.status(200).json({ ok:true, fon:code, source:url, holdings:visible, toplamAgirlik:visible.reduce((s,h)=>s+h.weight,0), attempts });
        }
      } catch(e) {
        attempts.push({ url, status:'ERR', error:e.message });
      }
    }

    return res.status(502).json({ ok:false, error:'FVT portfolio data unavailable after expanded attempts', fon:code, attempts });
  } catch(e) {
    return res.status(500).json({ ok:false, error:e && e.message ? e.message : String(e), fon:code });
  }
}