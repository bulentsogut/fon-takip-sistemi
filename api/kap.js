// Vercel Serverless Function: /api/kap?code=IJC
// KAP/PDF kaynaklı portföy ağırlığı okuyucu.
// Kaynak keşfi artık Ekofin'deki "Kaynak" linkinden başlar:
// Ekofin fon-portföy sayfası -> KAP bildirim sayfası -> Notification Attachments PDF -> PDF metni.

import https from 'node:https';
import pdfParse from 'pdf-parse';

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
  let x = String(value).replace(/%/g, '').replace(/TL|₺/gi, '').trim().replace(/\s+/g, '');
  if (!x) return NaN;
  if (x.includes(',') && x.includes('.')) {
    const lastComma = x.lastIndexOf(',');
    const lastDot = x.lastIndexOf('.');
    if (lastComma > lastDot) x = x.replace(/\./g, '').replace(',', '.');
    else x = x.replace(/,/g, '');
  } else {
    x = x.replace(',', '.');
  }
  return Number.parseFloat(x);
}

function httpsGet(url, accept = '*/*') {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
        'Accept': accept,
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.7,en;q=0.6',
        'Referer': 'https://ekofin.net/',
        'Cache-Control': 'no-cache'
      }
    }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        const nextUrl = new URL(r.headers.location, url).toString();
        r.resume();
        httpsGet(nextUrl, accept).then(resolve, reject);
        return;
      }
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode || 0, headers: r.headers || {}, buffer: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('KAP request timeout')));
    req.on('error', reject);
  });
}

async function fetchText(url) {
  const up = await httpsGet(url, 'text/html,application/json,text/plain,*/*');
  return { status: up.status, headers: up.headers, text: up.buffer.toString('utf8'), len: up.buffer.length };
}

async function fetchBuffer(url) {
  return httpsGet(url, 'application/pdf,application/octet-stream,*/*');
}

// pdf-parse default text extraction sometimes returns table columns in blocks
// (all percentages first, then all values, then all issuer names). For KAP portfolio
// PDFs we need row layout. This pagerender groups PDF text items by Y coordinate
// and sorts them by X coordinate so rows become parseable lines such as:
// US67066G1040 NVDA US EQUITY 7,192.00 70,666,911.20 5.99%
function renderPageWithLayout(pageData) {
  const renderOptions = {
    normalizeWhitespace: false,
    disableCombineTextItems: false
  };
  return pageData.getTextContent(renderOptions).then(function(textContent) {
    const rows = [];
    const tolerance = 2.2;

    for (const item of (textContent.items || [])) {
      const str = String(item.str || '').trim();
      if (!str) continue;
      const tr = item.transform || [];
      const x = Number(tr[4] || 0);
      const y = Number(tr[5] || 0);

      let row = rows.find(r => Math.abs(r.y - y) <= tolerance);
      if (!row) {
        row = { y, items: [] };
        rows.push(row);
      }
      row.items.push({ x, str });
    }

    rows.sort((a, b) => b.y - a.y);
    const lines = rows.map(row => {
      row.items.sort((a, b) => a.x - b.x);
      let out = '';
      let lastX = null;
      for (const it of row.items) {
        // Keep at least one space; add extra spacing for far columns to avoid
        // joining ISIN/ticker/numbers into a single token.
        if (out) {
          const gap = lastX === null ? 1 : Math.max(1, Math.min(8, Math.round((it.x - lastX) / 18)));
          out += ' '.repeat(gap);
        }
        out += it.str;
        lastX = it.x + Math.max(10, it.str.length * 5);
      }
      return out.replace(/\s+/g, ' ').trim();
    }).filter(Boolean);

    return lines.join('\n');
  });
}

function unique(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    if (!x || seen.has(x)) continue;
    seen.add(x); out.push(x);
  }
  return out;
}

function htmlDecode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripTags(html) {
  return htmlDecode(String(html || ''))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fileNameFromUrl(url) {
  try {
    const clean = decodeURIComponent(String(url || '').split('?')[0]);
    return clean.split('/').pop() || '';
  } catch (_) { return ''; }
}

function normalizeUrl(href, base) {
  try { return new URL(htmlDecode(href), base).toString(); }
  catch (_) { return ''; }
}

// 1) Ekofin'deki mavi "Bilgilendirme / Kaynak" linkini bul.
async function discoverKapNotificationFromEkofin(code, attempts) {
  const c = encodeURIComponent(code);
  const pages = [
    `https://ekofin.net/fonlar/detay/${c}/fon-portfoy`,
    `https://ekofin.net/fonlar/detay/${c}`
  ];
  const kapLinks = [];

  for (const page of pages) {
    try {
      const up = await fetchText(page);
      attempts.push({ step: 'ekofin-source-page', url: page, status: up.status, len: up.len });
      if (up.status < 200 || up.status >= 300) continue;
      const html = htmlDecode(up.text || '');

      // Doğrudan KAP bildirim linkleri.
      for (const m of html.matchAll(/https?:\/\/(?:www\.)?kap\.org\.tr\/tr\/Bildirim\/\d+/gi)) {
        kapLinks.push(m[0]);
      }
      for (const m of html.matchAll(/href=["']([^"']*\/tr\/Bildirim\/\d+[^"']*)["']/gi)) {
        kapLinks.push(normalizeUrl(m[1], page));
      }

      // "Kaynak" metni yakınında gizlenmiş link varsa onu öne al.
      const sourceRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]{0,300}?Kaynak[\s\S]{0,80}?<\/a>|Kaynak[\s\S]{0,300}?<a\b[^>]*href=["']([^"']+)["']/gi;
      for (const m of html.matchAll(sourceRe)) {
        const u = normalizeUrl(m[1] || m[2], page);
        if (/kap\.org\.tr\/tr\/Bildirim\/\d+/i.test(u)) kapLinks.unshift(u);
      }
    } catch (e) {
      attempts.push({ step: 'ekofin-source-page', url: page, error: e.message || String(e) });
    }
  }
  return unique(kapLinks);
}

// 2) KAP bildirim sayfasındaki Notification Attachments PDF linkini bul.
async function discoverPdfAttachmentsFromKapNotification(kapUrl, attempts) {
  const pdfs = [];
  try {
    const up = await fetchText(kapUrl);
    attempts.push({ step: 'kap-notification-page', url: kapUrl, status: up.status, len: up.len });
    if (up.status < 200 || up.status >= 300) return [];
    const html = htmlDecode(up.text || '');

    // Notification Attachments bölümü özellikle öncelikli.
    const attachmentAreaMatch = html.match(/Notification Attachments[\s\S]{0,6000}/i) || html.match(/Bildirim Ekleri[\s\S]{0,6000}/i);
    const areas = attachmentAreaMatch ? [attachmentAreaMatch[0], html] : [html];

    for (const area of areas) {
      for (const m of area.matchAll(/href=["']([^"']+(?:\.pdf|api\/file\/download|file\/download|DownloadFile|download)[^"']*)["']/gi)) {
        const u = normalizeUrl(m[1], kapUrl);
        if (u) pdfs.push(u);
      }
      // JSON/Next state içinde URL olarak geçebilir.
      for (const m of area.matchAll(/https?:\/\/(?:www\.)?kap\.org\.tr\/[^"'\\\s]+(?:\.pdf|api\/file\/download|file\/download)[^"'\\\s]*/gi)) {
        pdfs.push(htmlDecode(m[0]).replace(/\\u002F/g, '/'));
      }
      for (const m of area.matchAll(/\/tr\/api\/file\/download\/[A-Za-z0-9_-]+/gi)) {
        pdfs.push(normalizeUrl(m[0], kapUrl));
      }
    }

    // Son çare: bildirimin kendisinin PDF çıktısı. Ek PDF değil, ama bazen tablo metnini içerir.
    const id = (kapUrl.match(/\/Bildirim\/(\d+)/) || [])[1];
    if (id) pdfs.push(`https://kap.org.tr/tr/api/BildirimPdf/${id}`);
  } catch (e) {
    attempts.push({ step: 'kap-notification-page', url: kapUrl, error: e.message || String(e) });
  }
  return unique(pdfs);
}

const FUND_SLUGS = {
  IJC: 'ijc-is-portfoy-yari-iletken-teknolojileri-degisken-fon',
  CPT: 'cpt-rota-portfoy-cip-teknolojileri-degisken-fon'
};

const STATIC_PDF_SOURCES = {
  IJC: [
    'https://kap.org.tr/tr/api/BildirimPdf/1554720',
    'https://kap.org.tr/tr/api/file/download/4028328d9b827483019c416c02ed00a2'
  ],
  CPT: [
    'https://www.rotaportfoy.com.tr/media/0aab551g/cpt-mayis-2026-portfoy-dagilim-raporu.pdf'
  ]
};

const TR_MONTHS_NUM = {
  'ocak': 1, 'şubat': 2, 'subat': 2, 'mart': 3, 'nisan': 4,
  'mayıs': 5, 'mayis': 5, 'haziran': 6, 'temmuz': 7, 'ağustos': 8,
  'agustos': 8, 'eylül': 9, 'eylul': 9, 'ekim': 10, 'kasım': 11,
  'kasim': 11, 'aralık': 12, 'aralik': 12
};

function extractEkofinPublishPeriod(html, code) {
  const text = stripTags(html || '');
  const re = new RegExp(String(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "[^.]{0,220}?(\\d{1,2})\\s+([A-Za-zÇĞİÖŞÜçğıöşü]+)\\s+(20\\d{2})\\s+tarihinde", 'i');
  let m = text.match(re) || text.match(/(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]+)\s+(20\d{2})\s+tarihinde/i);
  if (!m) return null;
  let month = TR_MONTHS_NUM[String(m[2] || '').toLowerCase()];
  let year = Number(m[3]);
  if (!month || !year) return null;
  // KAP "3 Temmuz 2026" bildirimi genellikle önceki ayın raporu: 2026.06
  month -= 1;
  if (month <= 0) { month = 12; year -= 1; }
  return `${year}.${String(month).padStart(2, '0')}`;
}

async function discoverFintablesPdfUrls(code, attempts) {
  const c = encodeURIComponent(code);
  const pages = [
    `https://ekofin.net/fonlar/detay/${c}/fon-portfoy`,
    `https://ekofin.net/fonlar/detay/${c}`
  ];
  const out = [];
  for (const page of pages) {
    try {
      const up = await fetchText(page);
      attempts.push({ step: 'ekofin-period-page', url: page, status: up.status, len: up.len });
      if (up.status < 200 || up.status >= 300) continue;
      const period = extractEkofinPublishPeriod(up.text || '', code);
      if (period) {
        out.push(`https://storage.fintables.com/media/uploads/kap-attachments/${code}_${period}.pdf`);
      }
    } catch (e) {
      attempts.push({ step: 'ekofin-period-page', url: page, error: e.message || String(e) });
    }
  }
  return unique(out);
}


async function discoverLegacyKapPdfUrls(code, attempts) {
  const slug = FUND_SLUGS[code];
  if (!slug) return [];
  const pages = [
    `https://kap.org.tr/tr/fon-bilgileri/ozet/${slug}`,
    `https://kap.org.tr/tr/fon-bildirimleri/${slug}`
  ];
  const ids = [];
  for (const page of pages) {
    try {
      const up = await fetchText(page);
      attempts.push({ step: 'legacy-kap-fund-page', url: page, status: up.status, len: up.len });
      if (up.status < 200 || up.status >= 300) continue;
      const html = up.text;
      const re = /(?:Portf[öo]y\s+Da[ğg][ıi]l[ıi]m\s+Raporu[\s\S]{0,1500}?\/tr\/Bildirim\/(\d+))|(?:\/tr\/Bildirim\/(\d+)[\s\S]{0,1500}?Portf[öo]y\s+Da[ğg][ıi]l[ıi]m\s+Raporu)/gi;
      let m;
      while ((m = re.exec(html))) ids.push(m[1] || m[2]);
      const all = [...html.matchAll(/\/tr\/Bildirim\/(\d+)/g)].map(x => x[1]);
      ids.push(...all.slice(0, 8));
    } catch (e) {
      attempts.push({ step: 'legacy-kap-fund-page', url: page, error: e.message || String(e) });
    }
  }
  return unique(ids).map(id => `https://kap.org.tr/tr/api/BildirimPdf/${id}`);
}

async function discoverRotaPdfUrls(code, attempts) {
  if (code !== 'CPT') return [];
  const page = 'https://www.rotaportfoy.com.tr/fon-dunyasi/degisken-fonlar/cpt/';
  try {
    const up = await fetchText(page);
    attempts.push({ step: 'discover-rota-page', url: page, status: up.status, len: up.len });
    if (up.status < 200 || up.status >= 300) return [];
    const html = htmlDecode(up.text);
    const hrefs = [...html.matchAll(/href=["']([^"']+\.pdf[^"']*)["']/gi)].map(x => new URL(x[1], page).toString());
    const pdfs = hrefs.filter(u => /cpt/i.test(u) && /(portfoy|portf%C3%B6y|da[ğg]ilim|dagilim|dag[ıi]l[ıi]m)/i.test(decodeURIComponent(u)));
    return unique(pdfs.reverse());
  } catch (e) {
    attempts.push({ step: 'discover-rota-page', url: page, error: e.message || String(e) });
    return [];
  }
}

const HEADER_WORDS = new Set(['TOPLAM', 'TRY', 'USD', 'TL', 'FON', 'PORTFOY', 'PORTFÖY', 'DEGERI', 'DEĞERİ', 'KIYMET', 'MENKUL']);
const TURKISH_STOCKS = new Set(['ASELS','EKDMR','KAREL','TCELL','VESTL','ALCTL','ALTNY','ARDYZ','ARENA','ATATP','AZTEK','BINBN','DESPC','DOFRB','ESCOM','FONET','FORTE','HTTBT','INDES','KFEIN','KRONT','LINK','LOGO','MTRKS','NETAS','OBASE','PAPIL','PATEK','SMART','MIATK','SDTTR','THYAO','TUPRS','SISE','BIMAS','KCHOL','SAHOL','AKBNK','GARAN','YKBNK','ISCTR','ODINE','MANAS','NETCD','REEDR','MOBTL','EMPAE','PKART','INGRM']);
const US_HINTS = new Set(['NVDA','AMD','ASML','TSM','AVGO','QCOM','INTC','AMAT','LRCX','MU','ARM','MRVL','KLAC','ADI','TXN','NXPI','ON','MPWR','TER','SNPS','CDNS','MCHP','GFS','STM','SMCI','POWI','SWKS','MPWR','MTSI','WOLF','COHR','LSCC','QRVO','NXPI','ASX','UMC','OLED','ONTO','ON','INFY','AAPL','MSFT','GOOGL','GOOG','META','AMZN','TSLA','NFLX','ORCL','CRM','NOW','SHOP','ADBE','PANW','CRWD','DDOG','SNOW','PLTR','DELL','HPQ','IBM']);

function inferType(code, line) {
  const s = String(line || '').toUpperCase();
  if (US_HINTS.has(code)) return 'us';
  if (/\b(US|NL|XS|KY|IE|LU)[A-Z0-9]{8,}\b/.test(s)) return 'us';
  if (/\b[A-Z]{1,5}\s+US\s+EQUITY\b/.test(s) || /\bNASDAQ\b|\bNYSE\b|\bUS EQUITY\b/.test(s)) return 'us';
  if (TURKISH_STOCKS.has(code)) return 'bist';
  if (/^[A-Z]{2,6}$/.test(code)) return 'bist';
  return 'other';
}

function symbolFromLine(first, line) {
  const s = String(line || '').toUpperCase();
  const us = s.match(/\b([A-Z]{1,5})\s+US\s+EQUITY\b/);
  if (us) return us[1];
  const isinTicker = s.match(/\b(?:US|NL|XS|KY|IE|LU)[A-Z0-9]{8,}\s+([A-Z]{1,5})\b/);
  if (isinTicker) return isinTicker[1];
  return first;
}

function getLineWeight(line) {
  const pctMatches = [...line.matchAll(/(-?\d+(?:[.,]\d+)?)\s*%/g)].map(x => x[1]);
  if (pctMatches.length) return toNumber(pctMatches[pctMatches.length - 1]);

  // İş Portföy/IJC PDF'lerinde oran kolonları çoğu zaman % işaretsiz gelir:
  // ... TOPLAM DEĞER  GRUP (%)  TOPLAM(FPD)  TOPLAM(FTD)
  // Bu durumda satırın sonundaki 0-100 arası son ondalıklı değeri ağırlık kabul ediyoruz.
  const nums = [...String(line || '').matchAll(/(?<![A-Z0-9])(-?\d{1,3}(?:[.,]\d{1,6})|\d{1,3})(?![A-Z0-9])/g)]
    .map(x => toNumber(x[1]))
    .filter(n => Number.isFinite(n));
  const plausible = nums.filter(n => Math.abs(n) >= 0.005 && Math.abs(n) <= 100);
  if (!plausible.length) return NaN;
  return plausible[plausible.length - 1];
}

function lineLooksLikePortfolioHolding(line) {
  const upper = String(line || '').toUpperCase();
  if (/TOPLAM|PORTFÖYE ALIŞLAR|PORTFÖYDEN SATIŞLAR|GİDERLER|İTFALAR/.test(upper)) return false;
  if (/\b[A-Z]{1,5}\s+US\s+EQUITY\b/.test(upper)) return true;
  if (/\b(?:US|NL|XS|KY|IE|LU)[A-Z0-9]{8,}\b/.test(upper)) return true;
  if (/^[A-Z0-9]{2,8}\s+/.test(upper) && /\b(TL|USD|EUR)\b/.test(upper)) return true;
  if (/^[A-Z0-9]{2,8}\s+/.test(upper) && /\d+[.,]\d+/.test(upper)) return true;
  return false;
}


function isForbiddenAssetCode(code) {
  const c = cleanCode(code);
  if (!c) return true;
  const forbidden = new Set([
    'TOPLAM','TRY','USD','EUR','TL','RPP','RS1','CFO','TPP','RTP','RTPP','REPO','TERSREPO','TERSREPO','TERS','VADELITEM','VADELIMEV','VADELI','VADELİ','MEVDUAT','FINBONO','FINANSMAN','TAKASBANK','DOVIZKAMU','DÖVİZKAMU','KIYMADEN','KIYMETLI','KIYMETLİ','GMSTRF','YAPIKREDI','YAPIKREDİ','HAZIT','KIRASERT','KIRASERTF','KATILMA','FON','BORC','BORÇ','NAKIT','NAKİT','TEMINAT','TEMİNAT','SWAP','OPSİYON','OPSIYON','VARANT','EUROBOND','BONO','TAHVIL','TAHVİL'
  ]);
  if (forbidden.has(c)) return true;
  if (/^(REPO|TERS|VADELI|VADELİ|MEVDUAT|FIN|TAKAS|KIRA|HAZI|HAZIT|DOVIZ|DÖVİZ|KIY|BONO|TAHVIL|TAHVİL)/.test(c)) return true;
  return false;
}

function cleanParsedHoldings(holdings) {
  const out = [];
  const seen = new Set();
  for (const h of holdings || []) {
    const code = cleanCode(h && (h.code || h.symbol));
    if (!code || isForbiddenAssetCode(code) || seen.has(code)) continue;
    const weight = toNumber(h.weight);
    if (!Number.isFinite(weight) || Math.abs(weight) < 0.005 || Math.abs(weight) > 100) continue;
    const type = inferType(code, String(h.name || '') + ' ' + String(h.sourceCode || ''));
    // Only accept clear equity assets. US names must be recognizable; BIST must be short/known.
    if (type === 'other') continue;
    if (type === 'bist' && !TURKISH_STOCKS.has(code) && !/^[A-Z]{3,5}$/.test(code)) continue;
    seen.add(code);
    out.push(Object.assign({}, h, { code, symbol: code, weight: Number(weight.toFixed(4)), type, tip: type }));
  }
  out.sort((a,b) => b.weight - a.weight);
  return out;
}

function validateKapHoldings(holdings) {
  const list = cleanParsedHoldings(holdings);
  const bad = (holdings || []).map(h => cleanCode(h && (h.code || h.symbol))).filter(isForbiddenAssetCode);
  const sum = list.reduce((s,h) => s + (Number(h.weight)||0), 0);
  const hasForeign = list.some(h => String(h.type).toLowerCase() === 'us');
  // A clean KAP result can be partial, but must have a meaningful equity block.
  if (list.length < 3) return { ok:false, holdings:list, reason:'too_few_clean_equities', bad, sum, hasForeign };
  if (sum < 5 || sum > 115) return { ok:false, holdings:list, reason:'unreasonable_weight_sum', bad, sum, hasForeign };
  return { ok:true, holdings:list, reason:'ok', bad, sum, hasForeign };
}

function parseHoldingsFromText(text, fundCode) {
  const normalized = String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/([A-Z0-9]{2,14}\s+[A-Z0-9]{1,8}\s+US\s+EQUITY)/g, '\n$1')
    .replace(/\b(Hisse\s+Türk|Hisse\s+Yabancı|HİSSE SENETLERİ|HISSE SENETLERI|A\)\s*HİSSE SENETLERİ|A\)\s*HISSE SENETLERI)\b/gi, '\n$1\n')
    .replace(/([A-ZÇĞİÖŞÜ0-9]{2,14}\s+[A-ZÇĞİÖŞÜ0-9 .,&-]{2,80}\s+\d)/g, '\n$1');
  const lines = normalized.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const holdings = [];
  const seen = new Set();
  let inEquitySection = false;
  let sectionStarted = false;
  let equitySectionClosed = false;
  let hardStopReached = false;
  let section = '';

  const blocked = new Set([
    'TOPLAM','TRY','USD','EUR','TL','RPP','RS1','CFO','TPP','RTP','RTPP','REPO','TERSREPO',
    'VADELITEM','VADELIMEV','MEVDUAT','FINBONO','TAKASBANK','DOVIZKAMU','DÖVİZKAMU',
    'KIYMADEN','KIYMETLI','GMSTRF','YAPIKREDI','YAPIKREDİ'
  ]);

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    const upper = line.toUpperCase();

    // En kritik koruma: sadece 3- FON PORTFÖY DEĞERİ TABLOSU içindeki
    // hisse senetleri bloğunu oku. Hisse bölümünden çıkıldıktan sonra aynı PDF'in
    // ilerleyen sayfalarında gelen "Portföye Alışlar/Satışlar" tablosu tekrar
    // parse edilmemelidir. Bu yüzden equitySectionClosed=true olduktan sonra
    // Hisse Türk/Yabancı başlıkları dahil hiçbir şey yeniden başlatılmaz.
    const isEquityStart = /\bA\)?\s*H[İI]SSE SENETLER[İI]\b|\bA\)?\s*HISSE SENETLERI\b|^H[İI]SSE\s+T[ÜU]RK\b|^HISSE\s+T[UÜ]RK\b|^H[İI]SSE\s+YABANCI\b|^HISSE\s+YABANCI\b/.test(upper);

    const isHardStop = /\b4\s*-\s*FON TOPLAM DE[ĞG]ER[Iİ]\b|\b5\s*-\s*AY [İI]Ç[İI]NDE YAPILAN G[İI]DERLER\b|\b7\s*-\s*[İI]TFALAR\b|\b8\s*-?\s*PORTF[ÖO]YDEN SAT[Iİ][ŞS]LAR\b|\b9\s*-?\s*PORTF[ÖO]YE AL[Iİ][ŞS]LAR\b/.test(upper);

    const isNextAssetSection = (
      /^[B-Z]\)\s+/.test(upper) ||
      /\bB\)?\s*VARANTLAR\b|\bC\)?\s*DEVLET TAHV[İI]L[İI]\b|\bD\)?\s*BANKA BONOLAR[İI]\b|\bE\)?\s*F[İI]NANSMAN BONOLAR[İI]\b|\bF\)?\s*[ÖO]ZEL SEKT[ÖO]R TAHV[İI]LLER[İI]\b|\bG\)?\s*GEL[İI]R ORTAKLI[ĞG]I\b|\bH\)?\s*GEL[İI]RE ENDEKSL[İI]\b|\bI\)?\s*K[İI]RA SERT[İI]F[İI]KALAR[İI]\b|\bJ\)?\s*VARLI[ĞG]A DAYALI\b|\bK\)?\s*YABANCI SAB[İI]T GET[İI]R[İI]L[İI]\b|\bL\)?\s*ALTIN\b|\bM\)?\s*KATILMA HESAPLAR[İI]\b|\bN\)?\s*KATILMA BELGELER[İI]\b|\bO\)?\s*V[İI]OP\b|\bP\)?\s*OPS[İI]YON\b|\bR\)?\s*V[İI]OP NAK[İI]T\b|\bS\)?\s*D[ÖO]V[İI]ZE ENDEKSL[İI]\b|\bT\)?\s*REPO\b|\bU\)?\s*PARA P[İI]YASAS[İI]\b|\bV\)?\s*MEVDUAT\b|\bY\)?\s*D[İI][ĞG]ER\b/.test(upper)
    );

    if (isHardStop) {
      hardStopReached = true;
      break;
    }

    if (inEquitySection && isNextAssetSection) {
      inEquitySection = false;
      equitySectionClosed = true;
      continue;
    }

    if (!equitySectionClosed && !hardStopReached && isEquityStart) {
      inEquitySection = true;
      sectionStarted = true;
      section = upper;
      continue;
    }

    if (!inEquitySection) continue;
    if (/^TOPLAM\b|^AÇIKLAMA\b|^NOMINAL\b|^RAYIÇ\b|^%$|^İHRAÇÇI\b|^IHRACCI\b/.test(upper)) continue;
    if (!lineLooksLikePortfolioHolding(line)) continue;

    const weight = getLineWeight(line);
    if (!Number.isFinite(weight) || Math.abs(weight) < 0.005 || Math.abs(weight) > 100) continue;

    const first = cleanCode((line.match(/^([A-Z0-9]{2,14})\b/) || [])[1] || '');
    if (!first || first === fundCode || HEADER_WORDS.has(first) || blocked.has(first) || isForbiddenAssetCode(first)) continue;

    const symbol = cleanCode(symbolFromLine(first, line));
    const code = symbol || first;
    if (!code || blocked.has(code) || isForbiddenAssetCode(code) || seen.has(code)) continue;

    const type = inferType(code, line + ' ' + section);
    if (!['us','bist'].includes(type)) continue;

    // Bölüm dışında kalmış karma varlıklar yanlışlıkla yakalanmasın: US için US EQUITY/ISIN,
    // BIST için kısa hisse kodu gerekir.
    if (type === 'us' && !(/\b[A-Z]{1,5}\s+US\s+EQUITY\b/.test(upper) || /\b(?:US|NL)[A-Z0-9]{8,}\b/.test(upper))) continue;
    if (type === 'bist' && !/^[A-Z0-9]{2,6}\b/.test(code)) continue;

    seen.add(code);
    holdings.push({
      code,
      symbol: code,
      name: code,
      weight: Number(weight.toFixed(4)),
      type,
      tip: type,
      sourceCode: first
    });
  }
  holdings.sort((a,b) => b.weight - a.weight);
  return holdings;
}

async function buildPdfSources(code, attempts, manualPdf) {
  const pdfSources = [];
  if (manualPdf) pdfSources.push({ url: manualPdf, via: 'manual', notificationUrl: '' });

  const kapNotifications = await discoverKapNotificationFromEkofin(code, attempts);
  for (const kapUrl of kapNotifications) {
    const attachments = await discoverPdfAttachmentsFromKapNotification(kapUrl, attempts);
    for (const pdfUrl of attachments) pdfSources.push({ url: pdfUrl, via: 'ekofin-kaynak-kap-attachment', notificationUrl: kapUrl });
  }

  for (const pdfUrl of await discoverFintablesPdfUrls(code, attempts)) {
    pdfSources.push({ url: pdfUrl, via: 'ekofin-date-fintables-kap-attachment', notificationUrl: '' });
  }

  for (const pdfUrl of await discoverLegacyKapPdfUrls(code, attempts)) {
    pdfSources.push({ url: pdfUrl, via: 'kap-fund-page-fallback', notificationUrl: '' });
  }
  for (const pdfUrl of await discoverRotaPdfUrls(code, attempts)) {
    pdfSources.push({ url: pdfUrl, via: 'rota-fallback', notificationUrl: '' });
  }
  for (const pdfUrl of (STATIC_PDF_SOURCES[code] || [])) {
    pdfSources.push({ url: pdfUrl, via: 'static-fallback', notificationUrl: '' });
  }

  const seen = new Set();
  return pdfSources.filter(s => {
    if (!s || !s.url || seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok:false, error:'Only GET is supported' });

  const code = cleanCode((req.query && (req.query.code || req.query.kod || req.query.fon)) || '');
  const debug = String((req.query && req.query.debug) || '') === '1';
  const manualPdf = req.query && req.query.pdf ? String(req.query.pdf) : '';
  if (!code) return res.status(400).json({ ok:false, error:'Missing code parameter' });

  const attempts = [];
  const sources = await buildPdfSources(code, attempts, manualPdf);

  if (!sources.length) {
    return res.status(200).json({ ok:false, source:'kap-pdf', code, error:'No KAP/PDF source discovered from Ekofin Kaynak link or fallbacks', attempts: debug ? attempts : undefined });
  }

  for (const source of sources) {
    const url = source.url;
    try {
      const up = await fetchBuffer(url);
      attempts.push({ step: 'pdf', via: source.via, url, notificationUrl: source.notificationUrl || '', status: up.status, contentType: up.headers['content-type'] || '', len: up.buffer.length });
      if (up.status < 200 || up.status >= 300 || !up.buffer.length) continue;
      const parsed = await pdfParse(up.buffer, { pagerender: renderPageWithLayout });
      const text = parsed.text || '';
      const rawHoldings = parseHoldingsFromText(text, code);
      const validation = validateKapHoldings(rawHoldings);
      const holdings = validation.holdings;
      attempts[attempts.length - 1].parsed = rawHoldings.length;
      attempts[attempts.length - 1].cleanParsed = holdings.length;
      attempts[attempts.length - 1].validation = validation.reason;
      attempts[attempts.length - 1].badCodes = (validation.bad || []).slice(0, 12);
      attempts[attempts.length - 1].weightSum = Number((validation.sum || 0).toFixed(2));
      if (!validation.ok) continue;

      const pdfFile = fileNameFromUrl(url);
      const sourceLabel = (source.via === 'ekofin-kaynak-kap-attachment' || source.via === 'ekofin-date-fintables-kap-attachment')
        ? `KAP PDF (Ekofin Kaynak → ${pdfFile || 'Notification Attachment'})`
        : (source.via === 'manual' ? `KAP PDF (${pdfFile || 'manuel PDF'})` : `KAP PDF (${pdfFile || source.via})`);

      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
      return res.status(200).json({
        ok: true,
        source: sourceLabel,
        sourceType: 'kap-pdf',
        sourcePath: source.via,
        code,
        count: holdings.length,
        holdings,
        latestDate: '',
        aciklamaTarihi: '',
        pdfUrl: url,
        pdfFile,
        kapNotificationUrl: source.notificationUrl || '',
        sourceMessage: `Veriler KAP bildirim ekindeki PDF dosyasından okundu${pdfFile ? ': ' + pdfFile : ''}.`,
        debug: debug ? { attempts, preview: text.slice(0, 4000) } : undefined
      });
    } catch (err) {
      attempts.push({ step: 'pdf', via: source.via, url, notificationUrl: source.notificationUrl || '', error: err && err.message ? err.message : String(err) });
    }
  }

  return res.status(200).json({ ok:false, source:'kap-pdf', code, error:'PDF sources found but parsed empty or failed', attempts: debug ? attempts : undefined });
}
