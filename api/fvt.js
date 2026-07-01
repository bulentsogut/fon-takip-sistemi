// ORKA ENGINE Phase 2.2 — Vercel FVT Backend Proxy
// Put this file at: /api/fvt.js
//
// Purpose:
// - Keep the browser away from direct fvt.com.tr calls.
// - Return clean JSON every time, even when FVT/Cloudflare fails.
// - Try multiple FVT endpoint shapes with browser-like headers.
// - Support all existing query formats: ?code=TLY, ?kod=TLY, ?fon=TLY

const FVT_BASE = "https://fvt.com.tr";

function cleanCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}

function makeHeaders() {
  return {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Referer": "https://fvt.com.tr/",
    "Origin": "https://fvt.com.tr",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  };
}

function candidateUrls(code, type) {
  const c = encodeURIComponent(code);
  const urls = [];

  // Older/current shapes we have seen in the project.
  urls.push(`${FVT_BASE}/api/funds/${c}/distribution`);
  urls.push(`${FVT_BASE}/api/funds/${c}?include=distribution`);
  urls.push(`${FVT_BASE}/api/funds/${c}?type=distribution`);
  urls.push(`${FVT_BASE}/api/funds/${c}`);

  // Turkish/legacy naming candidates.
  urls.push(`${FVT_BASE}/api/fonlar/${c}/distribution`);
  urls.push(`${FVT_BASE}/api/fonlar/${c}?include=distribution`);
  urls.push(`${FVT_BASE}/api/fon/${c}/distribution`);
  urls.push(`${FVT_BASE}/api/fon/${c}`);

  // Query-based candidates.
  urls.push(`${FVT_BASE}/api/funds?code=${c}&type=${encodeURIComponent(type || "distribution")}`);
  urls.push(`${FVT_BASE}/api/funds?kod=${c}&type=${encodeURIComponent(type || "distribution")}`);
  urls.push(`${FVT_BASE}/api/fvt?code=${c}&type=${encodeURIComponent(type || "distribution")}`);
  urls.push(`${FVT_BASE}/api/fvt?kod=${c}&type=${encodeURIComponent(type || "distribution")}`);

  return [...new Set(urls)];
}

function looksHtml(text) {
  const t = String(text || "").trim().slice(0, 300).toLowerCase();
  return t.startsWith("<!doctype html") || t.startsWith("<html") || t.includes("<html");
}

async function fetchWithTimeout(url, ms = 18000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      method: "GET",
      headers: makeHeaders(),
      redirect: "follow",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=86400");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const code = cleanCode(req.query.code || req.query.kod || req.query.fon || req.query.fund);
  const type = String(req.query.type || "distribution").trim();

  if (!code) {
    res.status(400).json({
      ok: false,
      source: "orka-fvt-proxy",
      error: "missing fund code",
      usage: "/api/fvt?code=TLY&type=distribution"
    });
    return;
  }

  const attempts = [];
  const urls = candidateUrls(code, type);

  for (const url of urls) {
    try {
      const response = await fetchWithTimeout(url);
      const text = await response.text();
      const preview = text.slice(0, 240);

      attempts.push({
        url,
        status: response.status,
        contentType: response.headers.get("content-type") || "",
        len: text.length,
        html: looksHtml(text)
      });

      if (!response.ok) continue;
      if (!text || looksHtml(text)) continue;

      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        attempts[attempts.length - 1].json = false;
        continue;
      }

      res.status(200).json({
        ok: true,
        source: "orka-fvt-proxy",
        code,
        type,
        fetchedFrom: url,
        data
      });
      return;
    } catch (e) {
      attempts.push({
        url,
        status: "FETCH_ERROR",
        error: e && e.message ? e.message : String(e)
      });
    }
  }

  // Important: return JSON, not Cloudflare/HTML. The frontend can preserve old weights.
  res.status(502).json({
    ok: false,
    source: "orka-fvt-proxy",
    code,
    type,
    error: "FVT portfolio data unavailable after expanded attempts",
    attempts
  });
};
