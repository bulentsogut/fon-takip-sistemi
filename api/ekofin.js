// Vercel Serverless Function: /api/ekofin?code=TLY
//
// SORUN: Ekofin.net artık tamamen Next.js App Router ile server-side render
// ediliyor. Sayfanın kullandığı ayrı, herkese açık bir JSON API'si yok
// ("historical-distribution" adında bir endpoint mevcut değil / hiç var
// olmamış olabilir) — bu yüzden eski kod her zaman "ok:false" dönüyordu.
// Portföy ağırlıkları artık doğrudan sayfa HTML'inin içine gömülü olarak
// geliyor (RSC/SSR). Çözüm: gerçek sayfayı (fon-portfoy / özet rapor)
// çekip HTML içinden ağırlık verisini parse etmek.
//
// Kullanılan gerçek sayfalar:
//   https://ekofin.net/fonlar/detay/{KOD}/fon-portfoy   (tam liste)
//   https://ekofin.net/fonlar/detay/{KOD}                (özet - ilk 5 pozisyon, yedek)
//
// NOT: Bu bir HTML scraping çözümüdür. Ekofin sayfa yapısını değiştirirse
// (örn. hisse linklerinin path'i değişirse) tekrar bozulabilir. ?debug=1
// ile ham parse detaylarını görebilirsin.

import https from 'node:https';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

function cleanCode(code) {
  return String(code || '').toUpperCase().trim().replace(/[^A-Z0-9]/g, '');
}

function toNumber(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return value;
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

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json,text/plain,*/*',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.7,en;q=0.6',
        'Referer': 'https://ekofin.net/fonlar',
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

// ---- HTML scraping yardımcıları -------------------------------------------------

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const TR_MONTHS = {
  'ocak': '01', 'şubat': '02', 'subat': '02', 'mart': '03', 'nisan': '04',
  'mayıs': '05', 'mayis': '05', 'haziran': '06', 'temmuz': '07', 'ağustos': '08',
  'agustos': '08', 'eylül': '09', 'eylul': '09', 'ekim': '10', 'kasım': '11',
  'kasim': '11', 'aralık': '12', 'aralik': '12'
};

function extractAciklamaTarihi(html) {
  const text = stripTags(html);
  // Örn: "TLY portföy dağılımı ile ilgili veriler 8 Haziran 2026 tarihinde yayımlanan ..."
  const m = text.match(/(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]+)\s+(\d{4})\s+tarihinde/i);
  if (!m) return '';
  const day = m[1].padStart(2, '0');
  const month = TR_MONTHS[m[2].toLowerCase()];
  const year = m[3];
  if (!month) return '';
  return `${year}-${month}-${day}`;
}

// Sayfadaki her hisse/fon satırı bir <a href="/sirket/detay/KOD"> veya
// <a href="/fonlar/detay/KOD"> bloğu içinde geçiyor. Format değişse bile
// (TL ayraçlı / ayraçsız / "₺%" biçimli) satırdaki SON yüzdelik değer her
// zaman "Ağırlık" kolonudur — bu yüzden en sağlam yöntem budur.
function extractHoldingsFromHtml(html, fundCode) {
  const holdings = [];
  const seen = new Set();
  const anchorRe = /<a\b[^>]*href="\/(?:sirket|fonlar)\/detay\/([A-Za-z0-9]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html))) {
    const code = cleanCode(m[1]);
    if (!code || code === fundCode || seen.has(code)) continue;

    const inner = stripTags(m[2]);
    if (!inner || !/%/.test(inner)) continue;

    const pctMatches = [...inner.matchAll(/(-?\d+[.,]\d+)\s*%/g)].map(x => x[1]);
    if (pctMatches.length === 0) continue;

    const weight = toNumber(pctMatches[pctMatches.length - 1]);
    if (!Number.isFinite(weight) || Math.abs(weight) < 0.005 || Math.abs(weight) > 100) continue;

    // Fiyat: satırdaki ilk ondalıklı sayı (varsa)
    const priceMatch = inner.match(/(\d+[.,]\d{1,4})/);
    const price = priceMatch ? toNumber(priceMatch[1]) : NaN;

    seen.add(code);
    holdings.push({
      code,
      symbol: code,
      name: code,
      weight: Number(weight.toFixed(4)),
      type: 'bist',
      tip: 'bist',
      nominal: NaN,
      value: Number.isFinite(price) ? price : NaN
    });
  }

  holdings.sort((a, b) => b.weight - a.weight);
  return holdings;
}

function pageCandidates(code) {
  const c = encodeURIComponent(code);
  return [
    `https://ekofin.net/fonlar/detay/${c}/fon-portfoy`, // tam liste (öncelikli)
    `https://ekofin.net/fonlar/detay/${c}`               // özet rapor - yedek (ilk 5 pozisyon)
  ];
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Only GET is supported' });

  const code = cleanCode((req.query && (req.query.code || req.query.kod || req.query.fon || req.query.fonKodu)) || '');
  const debug = String((req.query && req.query.debug) || '') === '1';
  if (!code) return res.status(400).json({ ok: false, error: 'Missing code parameter' });

  const attempts = [];

  for (const url of pageCandidates(code)) {
    try {
      const upstream = await httpsGet(url);
      attempts.push({ url, status: upstream.status, contentType: upstream.headers['content-type'] || '', len: (upstream.body || '').length });

      if (upstream.status < 200 || upstream.status >= 300) continue;

      const holdings = extractHoldingsFromHtml(upstream.body || '', code);
      if (!holdings.length) {
        attempts[attempts.length - 1].parsed = 0;
        continue;
      }

      const aciklamaTarihi = extractAciklamaTarihi(upstream.body || '');
      const payload = {
        ok: true,
        source: 'ekofin-html',
        code,
        count: holdings.length,
        latestDate: aciklamaTarihi,
        aciklamaTarihi,
        holdings
      };

      if (debug) {
        payload.debug = {
          endpoint: url,
          attempts,
          textPreview: stripTags(upstream.body || '').slice(0, 2000)
        };
      }

      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
      return res.status(200).json(payload);
    } catch (err) {
      attempts.push({ url, error: err && err.message ? err.message : String(err) });
    }
  }

  return res.status(200).json({
    ok: false,
    source: 'ekofin-html',
    code,
    error: 'Ekofin sayfasından portföy verisi okunamadı (sayfa yapısı değişmiş olabilir)',
    attempts: debug ? attempts : undefined
  });
}
