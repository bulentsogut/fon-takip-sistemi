// Vercel Serverless Function: /api/kap?code=IJC
// KAP/PDF kaynaklı portföy ağırlığı okuyucu.
// Amaç: Ekofin'de eksik kalan yurtdışı hisseleri KAP Portföy Dağılım Raporu PDF'lerinden almak.

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
  // KAP PDF'lerinde genelde 1,234.56 veya 1.234,56 gelebilir.
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

const FUND_SLUGS = {
  IJC: 'ijc-is-portfoy-yari-iletken-teknolojileri-degisken-fon',
  CPT: 'cpt-rota-portfoy-cip-teknolojileri-degisken-fon'
};

// Sabit yedekler. KAP/şirket sayfasından dinamik bulunamazsa kullanılır.
const STATIC_PDF_SOURCES = {
  // IJC eski doğrulanmış KAP bildirimi; dinamik arama daha güncelini bulursa önce onu kullanır.
  IJC: [
    'https://kap.org.tr/tr/api/BildirimPdf/1554720',
    'https://kap.org.tr/tr/api/file/download/4028328d9b827483019c416c02ed00a2'
  ],
  // CPT için Rota sayfasından dönemsel rapor linki yakalanamazsa yedek.
  CPT: [
    'https://www.rotaportfoy.com.tr/media/0aab551g/cpt-mayis-2026-portfoy-dagilim-raporu.pdf'
  ]
};

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

async function discoverKapPdfUrls(code, attempts) {
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
      attempts.push({ step: 'discover-kap-page', url: page, status: up.status, len: up.len });
      if (up.status < 200 || up.status >= 300) continue;
      const html = up.text;
      // Aynı HTML içinde Portföy Dağılım Raporu yakınındaki bildirimleri öncele.
      const re = /(?:Portf[öo]y\s+Da[ğg][ıi]l[ıi]m\s+Raporu[\s\S]{0,1500}?\/tr\/Bildirim\/(\d+))|(?:\/tr\/Bildirim\/(\d+)[\s\S]{0,1500}?Portf[öo]y\s+Da[ğg][ıi]l[ıi]m\s+Raporu)/gi;
      let m;
      while ((m = re.exec(html))) ids.push(m[1] || m[2]);
      // Sayfalar bazen tüm bildirimleri tabloyla verir; ilk birkaç id yedek olarak alınır.
      const all = [...html.matchAll(/\/tr\/Bildirim\/(\d+)/g)].map(x => x[1]);
      ids.push(...all.slice(0, 8));
    } catch (e) {
      attempts.push({ step: 'discover-kap-page', url: page, error: e.message || String(e) });
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
    const pdfs = hrefs.filter(u => /cpt/i.test(u) && /(portfoy|portf%C3%B6y|portf%C3%B6y|da[ğg]ilim|dagilim|dag[ıi]l[ıi]m)/i.test(decodeURIComponent(u)));
    // Sayfada güncel raporlar genelde üstte/sonda olabilir; hepsini deneyeceğiz ama tekrarları temizleyeceğiz.
    return unique(pdfs.reverse());
  } catch (e) {
    attempts.push({ step: 'discover-rota-page', url: page, error: e.message || String(e) });
    return [];
  }
}

const HEADER_WORDS = new Set(['TOPLAM', 'TRY', 'USD', 'TL', 'FON', 'PORTFOY', 'PORTFÖY', 'DEGERI', 'DEĞERİ', 'KIYMET', 'MENKUL']);
const TURKISH_STOCKS = new Set(['ASELS','EKDMR','KAREL','TCELL','VESTL','ALCTL','ALTNY','ARDYZ','ARENA','ATATP','AZTEK','BINBN','DESPC','DOFRB','ESCOM','FONET','FORTE','HTTBT','INDES','KFEIN','KRONT','LINK','LOGO','MTRKS','NETAS','OBASE','PAPIL','PATEK','SMART','MIATK','SDTTR','THYAO','TUPRS','SISE','BIMAS','KCHOL','SAHOL','AKBNK','GARAN','YKBNK','ISCTR']);
const US_HINTS = new Set(['NVDA','AMD','ASML','TSM','AVGO','QCOM','INTC','AMAT','LRCX','MU','ARM','MRVL','KLAC','ADI','TXN','NXPI','ON','MPWR','TER','SNPS','CDNS','MCHP','GFS','STM','SMCI','AAPL','MSFT','GOOGL','GOOG','META','AMZN','TSLA','NFLX','ORCL']);

function inferType(code, line) {
  const s = String(line || '').toUpperCase();
  if (US_HINTS.has(code)) return 'us';
  if (/\b(US|NL|XS|KY|IE|LU)[A-Z0-9]{8,}\b/.test(code)) return 'us';
  if (/\b[A-Z]{1,5}\s+US\s+EQUITY\b/.test(s) || /\bNASDAQ\b|\bNYSE\b|\bUS EQUITY\b/.test(s)) return 'us';
  if (TURKISH_STOCKS.has(code)) return 'bist';
  if (/^[A-Z]{2,6}$/.test(code)) return 'bist';
  return 'other';
}

function symbolFromLine(first, line) {
  const s = String(line || '').toUpperCase();
  const us = s.match(/\b([A-Z]{1,5})\s+US\s+EQUITY\b/);
  if (us) return us[1];
  // ISIN + ticker yapısı: US67066G1040 NVDA US EQUITY
  const isinTicker = s.match(/\b(?:US|NL|XS|KY|IE|LU)[A-Z0-9]{8,}\s+([A-Z]{1,5})\b/);
  if (isinTicker) return isinTicker[1];
  return first;
}

function parseHoldingsFromText(text, fundCode) {
  const normalized = String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/([A-Z0-9]{2,14}\s+[A-Z0-9]{1,8}\s+US\s+EQUITY)/g, '\n$1')
    .replace(/([A-ZÇĞİÖŞÜ0-9]{2,14}\s+[A-ZÇĞİÖŞÜ0-9 .,&-]{2,80}\s+\d)/g, '\n$1');
  const lines = normalized.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const holdings = [];
  const seen = new Set();
  let inPortfolio = false;
  let section = '';

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (/FON PORTF[ÖO]Y DE[ĞG]ER[Iİ] TABLOSU|PORTF[ÖO]Y DA[ĞG][Iİ]L[Iİ]M/.test(upper)) inPortfolio = true;
    if (!inPortfolio && !/\b(US|NASDAQ|NYSE|EQUITY)\b/.test(upper)) continue;
    if (/FON TOPLAM DE[ĞG]ER[Iİ] TABLOSU|AY [İI]Ç[İI]NDE YAPILAN G[İI]DERLER|TOPLAM G[İI]DER/.test(upper)) break;
    if (/^[A-ZÇĞİÖŞÜ]\)/.test(upper)) section = upper;

    const pctMatches = [...line.matchAll(/(-?\d+(?:[.,]\d+)?)\s*%/g)].map(x => x[1]);
    if (!pctMatches.length) continue;
    const weight = toNumber(pctMatches[pctMatches.length - 1]);
    if (!Number.isFinite(weight) || Math.abs(weight) < 0.005 || Math.abs(weight) > 100) continue;

    const first = cleanCode((line.match(/^([A-Z0-9]{2,14})\b/) || [])[1] || '');
    if (!first || first === fundCode || HEADER_WORDS.has(first)) continue;
    if (/^TOPLAM/.test(upper)) continue;

    const symbol = cleanCode(symbolFromLine(first, line));
    const type = inferType(symbol || first, line + ' ' + section);
    if (!['us','bist'].includes(type)) continue;
    const code = symbol || first;
    if (!code || seen.has(code)) continue;

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

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok:false, error:'Only GET is supported' });

  const code = cleanCode((req.query && (req.query.code || req.query.kod || req.query.fon)) || '');
  const debug = String((req.query && req.query.debug) || '') === '1';
  const manualPdf = req.query && req.query.pdf ? String(req.query.pdf) : '';
  if (!code) return res.status(400).json({ ok:false, error:'Missing code parameter' });

  const attempts = [];
  let sources = [];
  if (manualPdf) sources.push(manualPdf);
  sources.push(...await discoverKapPdfUrls(code, attempts));
  sources.push(...await discoverRotaPdfUrls(code, attempts));
  sources.push(...(STATIC_PDF_SOURCES[code] || []));
  sources = unique(sources);

  if (!sources.length) {
    return res.status(200).json({ ok:false, source:'kap-pdf', code, error:'No KAP/PDF source configured or discovered for this fund', attempts: debug ? attempts : undefined });
  }

  for (const url of sources) {
    try {
      const up = await fetchBuffer(url);
      attempts.push({ step: 'pdf', url, status: up.status, contentType: up.headers['content-type'] || '', len: up.buffer.length });
      if (up.status < 200 || up.status >= 300 || !up.buffer.length) continue;
      const parsed = await pdfParse(up.buffer);
      const text = parsed.text || '';
      const holdings = parseHoldingsFromText(text, code);
      attempts[attempts.length - 1].parsed = holdings.length;
      if (!holdings.length) continue;
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
      return res.status(200).json({
        ok: true,
        source: url.includes('rotaportfoy') ? 'rota-pdf' : 'kap-pdf',
        code,
        count: holdings.length,
        holdings,
        latestDate: '',
        aciklamaTarihi: '',
        pdfUrl: url,
        debug: debug ? { attempts, preview: text.slice(0, 4000) } : undefined
      });
    } catch (err) {
      attempts.push({ step: 'pdf', url, error: err && err.message ? err.message : String(err) });
    }
  }

  return res.status(200).json({ ok:false, source:'kap-pdf', code, error:'PDF parsed empty or failed', attempts: debug ? attempts : undefined });
}
