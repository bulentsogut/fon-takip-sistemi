// Vercel Serverless Function: /api/tefas
//
// Kullanım:
//   POST /api/tefas?endpoint=fonFiyatBilgiGetir
//   POST /api/tefas?endpoint=fonBilgiGetir
//   GET  /api/tefas?mode=portfolio&code=TLY
//
// TEFAS güncel yapı (Temmuz 2026):
//   POST https://www.tefas.gov.tr/api/funds/{endpoint}
//   Authorization: Bearer <TEFAS web istemcisi servis anahtarı>

import https from 'node:https';
import crypto from 'node:crypto';

const TEFAS_BASE_URL = 'https://www.tefas.gov.tr';
const TEFAS_FUNDS_API = `${TEFAS_BASE_URL}/api/funds`;
const TEFAS_BEARER_TOKEN = 'ST-tefaswebwse3irfmSBj4iRAzGPbAlS94Se';

const ALLOWED_ENDPOINTS = new Set([
  'fonFiyatBilgiGetir',
  'fonBilgiGetir',
  'fonTurDnmGetiriGetir',
  'fonUnvanAra',
  'fonProfilDtyGetir',
  'fonKurucuGetir',
  'fonTurGetir',
  'fonPortfoyDagilimGetir',
  'fonPortfoyBilgiGetir',
  'fonVarlikDagilimGetir',
  'fonDagilimGetir'
]);

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

function cleanCode(code) {
  return String(code || '')
    .toUpperCase()
    .trim()
    .replace(/[^A-Z0-9]/g, '');
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

  if (x.includes(',') && x.includes('.')) {
    const lastComma = x.lastIndexOf(',');
    const lastDot = x.lastIndexOf('.');
    x = lastComma > lastDot
      ? x.replace(/\./g, '').replace(',', '.')
      : x.replace(/,/g, '');
  } else {
    x = x.replace(',', '.');
  }

  return Number.parseFloat(x);
}

function cookieHeaderFromSetCookie(setCookie) {
  if (!Array.isArray(setCookie)) return '';
  return setCookie
    .map(item => String(item).split(';')[0])
    .filter(Boolean)
    .join('; ');
}

function httpsRequest(url, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);

    const requestHeaders = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      Accept: '*/*',
      'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      Origin: TEFAS_BASE_URL,
      Referer: `${TEFAS_BASE_URL}/`,
      ...headers
    };

    const options = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      port: u.port || 443,
      timeout: 25000,
      headers: requestHeaders
    };

    const req = https.request(options, response => {
      let data = '';
      response.setEncoding('utf8');

      response.on('data', chunk => {
        data += chunk;
      });

      response.on('end', () => {
        resolve({
          status: response.statusCode || 0,
          headers: response.headers || {},
          body: data
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('TEFAS request timeout'));
    });

    req.on('error', reject);

    if (body) req.write(body);
    req.end();
  });
}

function normalizePayload(raw) {
  let json = raw;

  if (typeof raw === 'string') {
    json = JSON.parse(raw || '{}');
  }

  return (
    json.resultList ||
    json.data ||
    json.items ||
    json.result ||
    (Array.isArray(json) ? json : [])
  );
}

async function obtainTefasSessionCookie(fundCode = '') {
  const code = cleanCode(fundCode);
  const pageUrl = code
    ? `${TEFAS_BASE_URL}/tr/fon-detayli-analiz/${encodeURIComponent(code)}`
    : `${TEFAS_BASE_URL}/tr`;

  try {
    const response = await httpsRequest(pageUrl, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: `${TEFAS_BASE_URL}/`
      }
    });

    return {
      status: response.status,
      cookie: cookieHeaderFromSetCookie(response.headers['set-cookie'])
    };
  } catch (error) {
    return {
      status: 0,
      cookie: '',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function postCurrentEndpoint(endpoint, payload, cookie = '') {
  const normalizedPayload = {
    ...(payload || {}),
    dil: payload?.dil || 'TR'
  };

  // Fiyat geçmişi endpoint'i periyod bekliyor.
  if (
    endpoint === 'fonFiyatBilgiGetir' &&
    normalizedPayload.periyod === undefined
  ) {
    normalizedPayload.periyod = 12;
  }

  const body = JSON.stringify(normalizedPayload);
  const fundCode = cleanCode(
    normalizedPayload.fonKodu ||
    normalizedPayload.fonKod ||
    normalizedPayload.code ||
    ''
  );

  const headers = {
    Authorization: `Bearer ${TEFAS_BEARER_TOKEN}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'x-request-id': crypto.randomUUID(),
    Referer: fundCode
      ? `${TEFAS_BASE_URL}/tr/fon-detayli-analiz/${encodeURIComponent(fundCode)}`
      : `${TEFAS_BASE_URL}/tr`
  };

  if (cookie) headers.Cookie = cookie;

  return httpsRequest(
    `${TEFAS_FUNDS_API}/${encodeURIComponent(endpoint)}`,
    {
      method: 'POST',
      body,
      headers
    }
  );
}

async function proxyEndpoint(endpoint, payload) {
  const attempts = [];

  // İlk deneme: güncel endpoint + sabit web servis token'ı.
  try {
    const response = await postCurrentEndpoint(endpoint, payload);

    attempts.push({
      url: `${TEFAS_FUNDS_API}/${endpoint}`,
      status: response.status,
      len: (response.body || '').length,
      contentType: response.headers['content-type'] || '',
      usedSessionCookie: false
    });

    if (response.status >= 200 && response.status < 300) {
      try {
        return {
          ok: true,
          data: normalizePayload(response.body),
          attempts
        };
      } catch (error) {
        attempts[attempts.length - 1].jsonError =
          error instanceof Error ? error.message : String(error);
      }
    }
  } catch (error) {
    attempts.push({
      url: `${TEFAS_FUNDS_API}/${endpoint}`,
      error: error instanceof Error ? error.message : String(error),
      usedSessionCookie: false
    });
  }

  // 401/403 veya ilk isteğin başarısız olması halinde TEFAS sayfasından
  // oturum çerezi alıp aynı isteği bir kez daha dener.
  const fundCode = cleanCode(payload?.fonKodu || payload?.fonKod || '');
  const session = await obtainTefasSessionCookie(fundCode);

  attempts.push({
    step: 'session-bootstrap',
    status: session.status,
    hasCookie: Boolean(session.cookie),
    error: session.error
  });

  if (session.cookie) {
    try {
      const response = await postCurrentEndpoint(
        endpoint,
        payload,
        session.cookie
      );

      attempts.push({
        url: `${TEFAS_FUNDS_API}/${endpoint}`,
        status: response.status,
        len: (response.body || '').length,
        contentType: response.headers['content-type'] || '',
        usedSessionCookie: true
      });

      if (response.status >= 200 && response.status < 300) {
        try {
          return {
            ok: true,
            data: normalizePayload(response.body),
            attempts
          };
        } catch (error) {
          attempts[attempts.length - 1].jsonError =
            error instanceof Error ? error.message : String(error);
        }
      }
    } catch (error) {
      attempts.push({
        url: `${TEFAS_FUNDS_API}/${endpoint}`,
        error: error instanceof Error ? error.message : String(error),
        usedSessionCookie: true
      });
    }
  }

  return {
    ok: false,
    data: [],
    attempts
  };
}

function normalizeNonStockRows(rows) {
  const out = [];
  const seen = new Set();

  const nonStockKeywords = [
    ['TERSREPO', 'Ters Repo'],
    ['TERS REPO', 'Ters Repo'],
    ['REPO', 'Repo'],
    ['VADELİ', 'Vadeli Mevduat'],
    ['VADELI', 'Vadeli Mevduat'],
    ['MEVDUAT', 'Vadeli Mevduat'],
    ['NAKİT', 'Nakit'],
    ['NAKIT', 'Nakit'],
    ['PARA PİYASASI', 'Para Piyasası'],
    ['PARA PIYASASI', 'Para Piyasası'],
    ['LİKİT', 'Likit'],
    ['LIKIT', 'Likit'],
    ['KATILMA', 'Katılma Hesabı'],
    ['BORÇLANMA', 'Borçlanma Araçları'],
    ['BORCLANMA', 'Borçlanma Araçları'],
    ['TAHVİL', 'Tahvil'],
    ['TAHVIL', 'Tahvil'],
    ['BONO', 'Finansman Bonosu'],
    ['DİĞER', 'Diğer'],
    ['DIGER', 'Diğer']
  ];

  for (const row of rows || []) {
    const text = String(Object.values(row || {}).join(' ')).toUpperCase();

    let matched = null;
    for (const [keyword, label] of nonStockKeywords) {
      if (text.includes(keyword)) {
        matched = label;
        break;
      }
    }

    if (!matched) continue;

    let weight = NaN;
    for (const key of [
      'oran',
      'ORAN',
      'agirlik',
      'AGIRLIK',
      'portfoyOran',
      'PORTFOY_ORAN',
      'yuzde',
      'YUZDE',
      'percentage',
      'weight'
    ]) {
      const number = toNumber(row[key]);
      if (Number.isFinite(number)) {
        weight = number;
        break;
      }
    }

    if (
      !Number.isFinite(weight) ||
      Math.abs(weight) < 0.005 ||
      Math.abs(weight) > 100
    ) {
      continue;
    }

    const code = matched
      .toUpperCase()
      .replace(/İ/g, 'I')
      .replace(/Ğ/g, 'G')
      .replace(/Ü/g, 'U')
      .replace(/Ş/g, 'S')
      .replace(/Ö/g, 'O')
      .replace(/Ç/g, 'C')
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    if (seen.has(code)) continue;
    seen.add(code);

    out.push({
      code,
      name: matched,
      weight: Number(weight.toFixed(4)),
      type: 'cash',
      tip: 'cash',
      source: 'TEFAS'
    });
  }

  out.sort((a, b) => b.weight - a.weight);
  return out;
}

async function fetchDistribution(code) {
  const candidates = [
    'fonPortfoyDagilimGetir',
    'fonPortfoyBilgiGetir',
    'fonVarlikDagilimGetir',
    'fonDagilimGetir'
  ];

  const attempts = [];

  for (const endpoint of candidates) {
    const result = await proxyEndpoint(endpoint, {
      fonKodu: code,
      dil: 'TR'
    });

    attempts.push({
      endpoint,
      ok: result.ok,
      count: (result.data || []).length,
      attempts: result.attempts
    });

    const holdings = normalizeNonStockRows(result.data);

    if (holdings.length) {
      return {
        ok: true,
        holdings,
        attempts
      };
    }
  }

  return {
    ok: false,
    holdings: [],
    attempts
  };
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const debug = String(req.query?.debug || '') === '1';

  if (req.method === 'POST') {
    let body = {};

    try {
      body =
        typeof req.body === 'object' && req.body
          ? req.body
          : JSON.parse(req.body || '{}');
    } catch {
      return res.status(400).json({
        ok: false,
        error: 'Invalid JSON body'
      });
    }

    const endpoint = String(req.query?.endpoint || '')
      .replace(/[^A-Za-z0-9_]/g, '');

    if (!endpoint) {
      return res.status(400).json({
        ok: false,
        error: 'Missing endpoint'
      });
    }

    if (!ALLOWED_ENDPOINTS.has(endpoint)) {
      return res.status(400).json({
        ok: false,
        error: 'Unsupported TEFAS endpoint'
      });
    }

    const result = await proxyEndpoint(endpoint, body);

    if (debug) {
      return res.status(result.ok ? 200 : 502).json({
        ok: result.ok,
        resultList: result.data,
        attempts: result.attempts
      });
    }

    // index.html eski davranışla uyumlu: resultList doğrudan döner.
    return res.status(result.ok ? 200 : 502).json({
      resultList: result.data
    });
  }

  const mode = String(req.query?.mode || '');
  const code = cleanCode(
    req.query?.code ||
    req.query?.fonKodu ||
    req.query?.kod ||
    ''
  );

  if (mode === 'price') {
    if (!code) {
      return res.status(400).json({
        ok: false,
        error: 'Missing code'
      });
    }

    const result = await proxyEndpoint('fonFiyatBilgiGetir', {
      fonKodu: code,
      dil: 'TR',
      periyod: 12
    });

    const rows = Array.isArray(result.data) ? result.data : [];
    const sorted = rows
      .filter(row => row && row.tarih && Number.isFinite(Number(row.fiyat)))
      .sort((a, b) => String(a.tarih).localeCompare(String(b.tarih)));

    const latest = sorted.length ? sorted[sorted.length - 1] : null;
    const previous = sorted.length > 1 ? sorted[sorted.length - 2] : null;
    const dailyReturn =
      latest && previous && Number(previous.fiyat) !== 0
        ? ((Number(latest.fiyat) / Number(previous.fiyat)) - 1) * 100
        : null;

    return res.status(result.ok ? 200 : 502).json({
      ok: result.ok,
      source: 'TEFAS',
      code,
      count: sorted.length,
      latest,
      previous,
      dailyReturn,
      history: sorted,
      debug: debug ? { attempts: result.attempts } : undefined
    });
  }

  if (mode === 'portfolio') {
    if (!code) {
      return res.status(400).json({
        ok: false,
        error: 'Missing code'
      });
    }

    const result = await fetchDistribution(code);

    return res.status(200).json({
      ok: result.ok,
      source: 'tefas-nonstock',
      code,
      count: result.holdings.length,
      holdings: result.holdings,
      debug: debug
        ? { attempts: result.attempts }
        : undefined
    });
  }

  return res.status(400).json({
    ok: false,
    error: 'Unsupported TEFAS request',
    examples: [
      '/api/tefas?mode=price&code=TLY',
      '/api/tefas?mode=portfolio&code=TLY'
    ]
  });
}
