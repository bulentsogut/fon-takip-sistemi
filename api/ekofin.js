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
//   https://ekofin.net/fonlar/detay/{KOD}/fon-portfoy       (hisse portföyü)
//   https://ekofin.net/fonlar/detay/{KOD}/tasinan-fonlar    (fon içindeki diğer fonlar)
//   https://ekofin.net/fonlar/detay/{KOD}                    (özet - yedek)
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
function mergeHoldingInto(out, seen, item) {
  const code = cleanCode(item && (item.code || item.symbol));
  if (!code) return;
  const weight = toNumber(item && item.weight);
  if (!Number.isFinite(weight) || Math.abs(weight) < 0.005 || Math.abs(weight) > 100) return;

  // Aynı kod farklı sayfalardan gelirse en son gelen ağırlığı kullan, tipi koru/güncelle.
  if (seen.has(code)) {
    const old = out.find(x => x.code === code);
    if (old) {
      old.weight = Number(weight.toFixed(4));
      old.type = item.type || old.type || 'bist';
      old.tip = old.type;
      old.name = item.name || old.name || code;
    }
    return;
  }
  seen.add(code);
  const type = item.type || 'bist';
  out.push({
    code,
    symbol: code,
    name: item.name || code,
    weight: Number(weight.toFixed(4)),
    type,
    tip: type,
    nominal: Number.isFinite(toNumber(item.nominal)) ? toNumber(item.nominal) : NaN,
    value: Number.isFinite(toNumber(item.value)) ? toNumber(item.value) : NaN
  });
}

function extractHoldingsFromHtml(html, fundCode) {
  const holdings = [];
  const seen = new Set();

  // Ekofin'de hisse satırları /sirket/detay/KOD, taşınan fon satırları /fonlar/detay/KOD olarak gelir.
  // /fonlar/detay/{ANA_FON}/... gibi ana fon sayfası linklerini dışarıda bırakıyoruz.
  const anchorRe = /<a\b[^>]*href="\/(sirket|fonlar)\/detay\/([A-Za-z0-9]+)(?:\/[^\"]*)?"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html))) {
    const kind = String(m[1] || '').toLowerCase();
    const code = cleanCode(m[2]);
    if (!code || code === fundCode) continue;

    const inner = stripTags(m[3]);
    if (!inner || !/%/.test(inner)) continue;

    const pctMatches = [...inner.matchAll(/(-?\d+[.,]\d+)\s*%/g)].map(x => x[1]);
    if (pctMatches.length === 0) continue;

    // Güncel Portföy ve Taşınan Fonlar satırlarında son yüzdelik değer ağırlıktır.
    const weight = toNumber(pctMatches[pctMatches.length - 1]);
    if (!Number.isFinite(weight) || Math.abs(weight) < 0.005 || Math.abs(weight) > 100) continue;

    // Fiyat/değer: satırdaki ilk ondalıklı sayı (varsa)
    const priceMatch = inner.match(/(\d+[.,]\d{1,4})/);
    const price = priceMatch ? toNumber(priceMatch[1]) : NaN;

    mergeHoldingInto(holdings, seen, {
      code,
      name: code,
      weight,
      type: kind === 'fonlar' ? 'fund' : 'bist',
      value: Number.isFinite(price) ? price : NaN
    });
  }

  holdings.sort((a, b) => b.weight - a.weight);
  return holdings;
}

function mergeHoldings(primary, extra) {
  const out = [];
  const seen = new Set();
  (primary || []).forEach(h => mergeHoldingInto(out, seen, h));
  (extra || []).forEach(h => mergeHoldingInto(out, seen, h));
  out.sort((a, b) => b.weight - a.weight);
  return out;
}


function extractEkofinPriceInfo(html, fundCode) {
  const text = stripTags(html || '');
  const out = { name: fundCode, price: 0, dailyReturn: 0, weeklyReturn: 0, monthlyReturn: 0, size: 0, investors: 0, date: '' };

  // Fon adı: sayfada genelde "TLY - ..." veya başlık içinde geçer. Yoksa kod kullanılır.
  const nameMatch = text.match(new RegExp('\\b' + fundCode + '\\b\\s*[-–—]?\\s*([^|]{8,120}?)(?:Fon Fiyat|Günlük|Portföy|Yatırımcı|$)', 'i'));
  if (nameMatch && nameMatch[1]) out.name = (fundCode + ' ' + nameMatch[1]).replace(/\s+/g, ' ').trim().slice(0, 160);

  // Fiyatı bulmak için önce etiketli alanları deneriz.
  const pricePatterns = [
    /(?:Fon\s*Fiyatı|Birim\s*Pay\s*Değeri|Son\s*Fiyat|Fiyat)\s*[:：]?\s*([0-9]+[\.,][0-9]{3,8})/i,
    /([0-9]+[\.,][0-9]{3,8})\s*(?:TL|₺)\b/i
  ];
  for (const re of pricePatterns) {
    const m = text.match(re);
    if (m) { const n = toNumber(m[1]); if (Number.isFinite(n) && n > 0 && n < 100000) { out.price = n; break; } }
  }

  function pctNear(labelRe) {
    const idx = text.search(labelRe);
    if (idx < 0) return 0;
    const part = text.slice(idx, idx + 250);
    const m = part.match(/(-?\d+[\.,]\d+)\s*%/);
    return m ? toNumber(m[1]) : 0;
  }
  out.dailyReturn = pctNear(/Günlük|1\s*Gün/i);
  out.weeklyReturn = pctNear(/Haftalık|1\s*Hafta/i);
  out.monthlyReturn = pctNear(/Aylık|1\s*Ay/i);

  const dt = extractAciklamaTarihi(html || '');
  out.date = dt || '';
  return out.price > 0 || out.dailyReturn || out.weeklyReturn || out.monthlyReturn ? out : null;
}

function pageCandidates(code) {
  const c = encodeURIComponent(code);
  return [
    { url: `https://ekofin.net/fonlar/detay/${c}/fon-portfoy`, kind: 'portfolio' },
    { url: `https://ekofin.net/fonlar/detay/${c}/tasinan-fonlar`, kind: 'carried-funds' },
    { url: `https://ekofin.net/fonlar/detay/${c}`, kind: 'summary' }
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
  const collected = [];
  let aciklamaTarihi = '';
  let priceInfo = null;
  const usedEndpoints = [];

  for (const candidate of pageCandidates(code)) {
    const url = candidate.url;
    try {
      const upstream = await httpsGet(url);
      attempts.push({ url, kind: candidate.kind, status: upstream.status, contentType: upstream.headers['content-type'] || '', len: (upstream.body || '').length });

      if (upstream.status < 200 || upstream.status >= 300) continue;

      const html = upstream.body || '';
      const holdings = extractHoldingsFromHtml(html, code);
      attempts[attempts.length - 1].parsed = holdings.length;
      const pi = extractEkofinPriceInfo(html, code);
      if (pi && !priceInfo) priceInfo = pi;

      const dt = extractAciklamaTarihi(html);
      if (dt && !aciklamaTarihi) aciklamaTarihi = dt;

      if (holdings.length) {
        usedEndpoints.push(candidate.kind);
        holdings.forEach(h => collected.push(h));
      }

      // Özet sayfa sadece yedek. Fon-portföy veya taşınan-fonlar veri verdiyse özetten veri ekleyip bozmayalım.
      if (candidate.kind === 'summary' && collected.length) break;
    } catch (err) {
      attempts.push({ url, kind: candidate.kind, error: err && err.message ? err.message : String(err) });
    }
  }

  const holdings = mergeHoldings([], collected);
  if (holdings.length) {
    const payload = {
      ok: true,
      source: usedEndpoints.includes('carried-funds') ? 'ekofin-html+tasınan-fonlar' : 'ekofin-html',
      sourceMessage: usedEndpoints.includes('carried-funds') ? 'Taşınan fonlar Ekofin /tasinan-fonlar sayfasından eklendi.' : '',
      code,
      count: holdings.length,
      latestDate: aciklamaTarihi,
      aciklamaTarihi,
      info: priceInfo || undefined,
      price: priceInfo ? priceInfo.price : undefined,
      dailyReturn: priceInfo ? priceInfo.dailyReturn : undefined,
      holdings
    };

    if (debug) {
      payload.debug = {
        usedEndpoints,
        attempts,
        sample: holdings.slice(0, 8)
      };
    }

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    return res.status(200).json(payload);
  }

  if (priceInfo) {
    return res.status(200).json({
      ok: true,
      source: 'ekofin-info',
      code,
      count: 0,
      latestDate: aciklamaTarihi,
      aciklamaTarihi,
      info: priceInfo,
      price: priceInfo.price,
      dailyReturn: priceInfo.dailyReturn,
      holdings: [],
      debug: debug ? { usedEndpoints, attempts, priceInfo } : undefined
    });
  }

  return res.status(200).json({
    ok: false,
    source: 'ekofin-html',
    code,
    error: 'Ekofin sayfasından portföy verisi okunamadı (sayfa yapısı değişmiş olabilir)',
    attempts: debug ? attempts : undefined
  });
}
