// ORKA ENGINE Phase 2.3 — FVT App Token + Distribution Provider
// Put this file at: /api/fvt.js
//
// Goal:
// Browser'da çalışan gerçek FVT akışını Vercel backend tarafında taklit eder:
// 1) /api/app-token ile fvt_at cookie alır
// 2) /api/funds/{CODE}/distribution çağırır
// 3) FVT JSON'unu ORKA holdings formatına normalize eder

const FVT_ORIGIN = "https://fvt.com.tr";

function cleanCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}

function randomDeviceId() {
  // FVT tarayıcı akışında x-device-id istiyor. Kalıcı olmasına gerek yok.
  return Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-8);
}

function pickSetCookie(headers) {
  // Vercel/Node fetch ortamına göre set-cookie erişimi değişebilir.
  try {
    if (typeof headers.getSetCookie === "function") {
      return headers.getSetCookie().join("; ");
    }
  } catch (_) {}
  try {
    return headers.get("set-cookie") || "";
  } catch (_) {
    return "";
  }
}

function extractFvtCookie(setCookieHeader) {
  const raw = String(setCookieHeader || "");
  const m = raw.match(/fvt_at=([^;,\s]+)/i);
  return m ? `fvt_at=${m[1]}` : "";
}

function makeBaseHeaders(deviceId) {
  return {
    "accept": "application/json, text/plain, */*",
    "accept-language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    "pragma": "no-cache",
    "priority": "u=1, i",
    "referer": `${FVT_ORIGIN}/fonlar/yatirim-fonlari/TLY`,
    "sec-ch-ua": "\"Google Chrome\";v=\"149\", \"Chromium\";v=\"149\", \"Not)A;Brand\";v=\"24\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "x-device-id": deviceId
  };
}

async function fetchText(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch (_) { return null; }
}

function looksHtml(text) {
  const t = String(text || "").trim().slice(0, 200).toLowerCase();
  return t.startsWith("<!doctype") || t.startsWith("<html") || t.includes("<html");
}

function n(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).replace("%", "").replace(",", ".").trim();
  const x = Number(s);
  return Number.isFinite(x) ? x : 0;
}

function normalizeDistribution(code, json) {
  const data = json && json.data ? json.data : json;
  const items = Array.isArray(data && data.items) ? data.items : Array.isArray(data) ? data : [];

  const holdings = items.map((it) => {
    const holdingCode = String(it.hisseKodu || it.code || it.kod || "").trim().toUpperCase();
    const isFund = !!String(it.fonAdi2 || "").trim();
    const name = String(it.sirketAdi || it.fonAdi2 || it.name || holdingCode).trim();
    const weight = n(it.agirlik ?? it.value ?? it.weight);
    const oldWeight = n(it.eskiAgirlik);
    const diff = n(it.fark);
    const liveChange = n(it.degisimCanli ?? it.degisim ?? it.oranCanli ?? it.oran);

    let type = "bist";
    if (isFund) type = "fund";
    if (it.yabanci === 1 || it.yabanci === "1") type = "us";
    if (it.etf === 1 || it.etf === "1") type = "fund";

    return {
      code: holdingCode,
      name,
      weight,
      oldWeight,
      diff,
      change: liveChange,
      type,
      sector: String(it.sektorAdi || "").trim(),
      raw: it
    };
  }).filter((h) => h.code && Number.isFinite(h.weight));

  const meta = data && data.meta ? data.meta : {};
  return {
    ok: true,
    source: "fvt-app-token-distribution",
    code,
    holdings,
    aciklamaTarihi: meta.aciklamaTarihi || "",
    meta,
    raw: json
  };
}

async function getAppToken(deviceId, attempts) {
  const url = `${FVT_ORIGIN}/api/app-token`;
  const headers = makeBaseHeaders(deviceId);
  headers.referer = `${FVT_ORIGIN}/fonlar/yatirim-fonlari/TLY`;

  const { res, text } = await fetchText(url, {
    method: "GET",
    headers,
    redirect: "follow"
  });

  const setCookie = pickSetCookie(res.headers);
  const cookie = extractFvtCookie(setCookie);

  attempts.push({
    step: "app-token",
    url,
    status: res.status,
    contentType: res.headers.get("content-type") || "",
    setCookieFound: !!setCookie,
    fvtAtFound: !!cookie,
    preview: text.slice(0, 160)
  });

  // Bazı ortamlarda cookie header görünmezse body içinde token olabilir.
  let bodyToken = "";
  const j = safeJson(text);
  if (j) {
    const possible = j.token || j.appToken || j.accessToken || (j.data && (j.data.token || j.data.appToken || j.data.accessToken));
    if (possible) bodyToken = `fvt_at=${possible}`;
  }

  return cookie || bodyToken;
}

async function fetchDistribution(code, deviceId, cookie, attempts) {
  const url = `${FVT_ORIGIN}/api/funds/${encodeURIComponent(code)}/distribution`;
  const headers = makeBaseHeaders(deviceId);
  headers.referer = `${FVT_ORIGIN}/fonlar/yatirim-fonlari/${encodeURIComponent(code)}`;
  if (cookie) headers.cookie = cookie;

  const { res, text } = await fetchText(url, {
    method: "GET",
    headers,
    redirect: "follow"
  });

  attempts.push({
    step: "distribution",
    url,
    status: res.status,
    contentType: res.headers.get("content-type") || "",
    len: text.length,
    html: looksHtml(text),
    preview: text.slice(0, 180)
  });

  return { res, text };
}

async function fetchAssetChart(code, deviceId, cookie, attempts) {
  const url = `${FVT_ORIGIN}/api/funds/${encodeURIComponent(code)}/asset-chart`;
  const headers = makeBaseHeaders(deviceId);
  headers.referer = `${FVT_ORIGIN}/fonlar/yatirim-fonlari/${encodeURIComponent(code)}`;
  if (cookie) headers.cookie = cookie;

  const { res, text } = await fetchText(url, { method: "GET", headers, redirect: "follow" });

  attempts.push({
    step: "asset-chart-fallback",
    url,
    status: res.status,
    contentType: res.headers.get("content-type") || "",
    len: text.length,
    html: looksHtml(text),
    preview: text.slice(0, 180)
  });

  return { res, text };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const code = cleanCode(req.query.code || req.query.kod || req.query.fon || req.query.fund);
  const type = String(req.query.type || "distribution").trim();

  if (!code) {
    res.status(400).json({
      ok: false,
      source: "fvt-app-token-distribution",
      error: "missing fund code",
      usage: "/api/fvt?code=TLY&type=distribution"
    });
    return;
  }

  const deviceId = String(req.query.deviceId || req.headers["x-device-id"] || randomDeviceId());
  const attempts = [];

  try {
    const cookie = await getAppToken(deviceId, attempts);

    const dist = await fetchDistribution(code, deviceId, cookie, attempts);
    const distJson = safeJson(dist.text);

    if (dist.res.ok && distJson && !looksHtml(dist.text)) {
      const normalized = normalizeDistribution(code, distJson);
      normalized.deviceIdUsed = deviceId;
      normalized.cookieUsed = !!cookie;
      normalized.attempts = attempts;
      res.status(200).json(normalized);
      return;
    }

    // Fallback: ana portföy sınıf dağılımı. Detay hisse verisi değil ama temiz JSON döner.
    const asset = await fetchAssetChart(code, deviceId, cookie, attempts);
    const assetJson = safeJson(asset.text);

    if (asset.res.ok && assetJson && !looksHtml(asset.text)) {
      res.status(200).json({
        ok: true,
        source: "fvt-app-token-asset-chart-fallback",
        code,
        holdings: [],
        assetChart: assetJson,
        aciklamaTarihi: "",
        deviceIdUsed: deviceId,
        cookieUsed: !!cookie,
        attempts
      });
      return;
    }

    res.status(502).json({
      ok: false,
      source: "fvt-app-token-distribution",
      code,
      type,
      error: "FVT distribution data unavailable",
      deviceIdUsed: deviceId,
      cookieUsed: !!cookie,
      attempts
    });
  } catch (e) {
    attempts.push({ step: "handler-error", error: e && e.message ? e.message : String(e) });
    res.status(500).json({
      ok: false,
      source: "fvt-app-token-distribution",
      code,
      type,
      error: e && e.message ? e.message : String(e),
      attempts
    });
  }
};
