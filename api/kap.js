// Vercel Serverless Function: /api/kap?code=CPT
// KAP/PDF kaynaklı portföy ağırlığı okuyucu.
// Amaç: Ekofin'de görünmeyen yurtdışı hisseleri (CPT/IJC gibi) KAP portföy dağılım raporundan almak.

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
  if (x.includes(',') && x.includes('.')) x = x.replace(/,/g, '');
  else x = x.replace(',', '.');
  return Number.parseFloat(x);
}

function httpsBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
        'Accept': 'application/pdf,application/octet-stream,*/*',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.7,en;q=0.6',
        'Cache-Control': 'no-cache'
      }
    }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        const nextUrl = new URL(r.headers.location, url).toString();
        r.resume();
        httpsBuffer(nextUrl).then(resolve, reject);
        return;
      }
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode || 0, headers: r.headers || {}, buffer: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('KAP PDF request timeout')));
    req.on('error', reject);
  });
}

// İlk sürüm: doğrulanmış PDF kaynakları. Yeni rapor çıktıkça sadece bu URL'ler güncellenebilir.
// CPT için Rota'nın yayınladığı aynı portföy dağılım PDF'i kullanılıyor; içinde yurtdışı hisseler açık geliyor.
const PDF_SOURCES = {
  CPT: [
    'https://www.rotaportfoy.com.tr/media/0aab551g/cpt-mayis-2026-portfoy-dagilim-raporu.pdf'
  ],
  IJC: [
    'https://kap.org.tr/tr/api/file/download/4028328d9b827483019c416c02ed00a2'
  ]
};

const HEADER_WORDS = new Set(['TOPLAM', 'TRY', 'USD', 'TL', 'FON', 'PORTFOY', 'PORTFÖY', 'DEGERI', 'DEĞERİ']);
const TURKISH_STOCKS = new Set(['ASELS','EKDMR','KAREL','TCELL','VESTL','ALCTL','ALTNY','ARDYZ','ARENA','ATATP','AZTEK','BINBN','DESPC','DOFRB','ESCOM','FONET','FORTE','HTTBT','INDES','KFEIN','KRONT','LINK','LOGO','MTRKS','NETAS','OBASE','PAPIL','PATEK','SMART','AZTEK','MIATK','SDTTR']);

function inferType(code, line) {
  const s = String(line || '').toUpperCase();
  if (/\b(US|NL|XS)[A-Z0-9]{8,}\b/.test(code) || /\bUS EQUITY\b/.test(s)) return 'us';
  if (/\b[A-Z]{1,5}\s+US\s+EQUITY\b/.test(s)) return 'us';
  if (TURKISH_STOCKS.has(code)) return 'bist';
  if (/^[A-Z]{2,6}$/.test(code)) return 'bist';
  return 'other';
}

function symbolFromLine(code, line) {
  const s = String(line || '').toUpperCase();
  const us = s.match(/\b([A-Z]{1,5})\s+US\s+EQUITY\b/);
  if (us) return us[1];
  return code;
}

function parseHoldingsFromText(text, fundCode) {
  const lines = String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const holdings = [];
  const seen = new Set();
  let inPortfolio = false;
  let section = '';

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (/FON PORTF[ÖO]Y DE[ĞG]ER[Iİ] TABLOSU/.test(upper)) inPortfolio = true;
    if (!inPortfolio) continue;
    if (/FON TOPLAM DE[ĞG]ER[Iİ] TABLOSU|AY [İI]Ç[İI]NDE YAPILAN G[İI]DERLER/.test(upper)) break;
    if (/^[A-ZÇĞİÖŞÜ]\)/.test(upper)) section = upper;

    // Tipik satır:
    // US67066G1040 NVDA US EQUITY 7,192.00 70,666,911.20 5.99%
    // ASELS ASELSAN ... 216,491.00 82,320,702.75 6.98%
    const pct = line.match(/(-?\d+(?:[.,]\d+)?)\s*%\s*$/);
    if (!pct) continue;
    const weight = toNumber(pct[1]);
    if (!Number.isFinite(weight) || Math.abs(weight) < 0.005 || Math.abs(weight) > 100) continue;

    const first = cleanCode((line.match(/^([A-Z0-9]{2,14})\b/) || [])[1] || '');
    if (!first || first === fundCode || HEADER_WORDS.has(first)) continue;
    if (/^TOPLAM/.test(upper)) continue;

    const type = inferType(first, line + ' ' + section);
    if (!['us','bist'].includes(type)) continue;
    const symbol = symbolFromLine(first, line);
    const code = cleanCode(symbol || first);
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
  if (!code) return res.status(400).json({ ok:false, error:'Missing code parameter' });

  const sources = PDF_SOURCES[code] || [];
  if (!sources.length) return res.status(200).json({ ok:false, source:'kap-pdf', code, error:'No KAP/PDF source configured for this fund' });

  const attempts = [];
  for (const url of sources) {
    try {
      const up = await httpsBuffer(url);
      attempts.push({ url, status: up.status, contentType: up.headers['content-type'] || '', len: up.buffer.length });
      if (up.status < 200 || up.status >= 300 || !up.buffer.length) continue;
      const parsed = await pdfParse(up.buffer);
      const text = parsed.text || '';
      const holdings = parseHoldingsFromText(text, code);
      attempts[attempts.length - 1].parsed = holdings.length;
      if (!holdings.length) continue;
      return res.status(200).json({
        ok: true,
        source: code === 'CPT' ? 'rota-pdf' : 'kap-pdf',
        code,
        count: holdings.length,
        holdings,
        latestDate: '',
        aciklamaTarihi: '',
        debug: debug ? { attempts, preview: text.slice(0, 3000) } : undefined
      });
    } catch (err) {
      attempts.push({ url, error: err && err.message ? err.message : String(err) });
    }
  }
  return res.status(200).json({ ok:false, source:'kap-pdf', code, error:'PDF parsed empty or failed', attempts: debug ? attempts : undefined });
}
