// ORKA ENGINE Phase 3.1 — FVT Browser JSON Importer
// Put this file at: /js/orka-fvt-browser-import.js
//
// Amaç:
// Browser Provider'ın ürettiği orka_fvt_browser_provider_YYYY-MM-DD.json dosyasını
// mevcut HTML içine alıp FUNDS[code].holdings yapısına işler.

(function(){
  function toastSafe(msg, type){
    if (typeof toast === "function") toast(msg, type || "ok");
    else if (typeof setStatus === "function") setStatus(type === "err" ? "error" : "live", msg);
    else console.log("[ORKA FVT IMPORT]", msg);
  }

  function normalizeHolding(h){
    return {
      code: String(h.code || "").trim().toUpperCase(),
      name: String(h.name || h.code || "").trim(),
      weight: Number(h.weight || 0),
      oldWeight: Number(h.oldWeight || 0),
      diff: Number(h.diff || 0),
      change: Number(h.change || 0),
      type: h.type || "bist",
      sector: h.sector || ""
    };
  }

  function ensureFund(code){
    code = String(code || "").trim().toUpperCase();
    if (!code) return null;

    if (typeof ensureFundDefinition === "function") {
      try { return ensureFundDefinition(code); } catch(e) {}
    }

    if (typeof FUNDS === "object") {
      if (!FUNDS[code]) {
        FUNDS[code] = {
          id: code,
          code: code,
          name: code,
          color: "#38bdf8",
          holdings: [],
          custom: true
        };
      }
      return FUNDS[code];
    }

    return null;
  }

  function saveAfterImport(){
    try { if (typeof saveCustomFundsFromRegistry === "function") saveCustomFundsFromRegistry(); } catch(e){}
    try { if (typeof saveFVTPortfolios === "function") saveFVTPortfolios(); } catch(e){}
    try { if (typeof fonFirebaseSave === "function") fonFirebaseSave(true); } catch(e){}
    try { if (typeof renderFunds === "function") renderFunds(); } catch(e){}
    try { if (typeof updateUI === "function") updateUI(); } catch(e){}
    try { if (typeof renderGercekPanel === "function") renderGercekPanel(); } catch(e){}
    try { if (typeof renderKiyasTablosu === "function") renderKiyasTablosu(); } catch(e){}
  }

  async function importJsonObject(payload){
    if (!payload || payload.source !== "orka-browser-provider" || !payload.funds) {
      throw new Error("Bu dosya ORKA Browser Provider JSON formatında değil.");
    }

    var imported = 0;
    var failed = [];

    Object.keys(payload.funds).forEach(function(code){
      var item = payload.funds[code];
      if (!item || !item.ok || !Array.isArray(item.holdings) || item.holdings.length === 0) {
        failed.push(code);
        return;
      }

      var fund = ensureFund(code);
      if (!fund) {
        failed.push(code);
        return;
      }

      fund.holdings = item.holdings.map(normalizeHolding).filter(function(h){ return h.code; });
      fund.aciklamaTarihi = item.aciklamaTarihi || "";
      fund.assetChart = item.assetChart || null;
      fund.custom = fund.custom || false;

      // Bazı eski sürümlerde ayrı FVT portföy cache objesi olabilir.
      try {
        if (typeof window.FVT_PORTFOYLER === "object") {
          window.FVT_PORTFOYLER[code] = {
            holdings: fund.holdings,
            aciklamaTarihi: fund.aciklamaTarihi,
            assetChart: fund.assetChart,
            updatedAt: new Date().toISOString(),
            source: "browser-provider-import"
          };
        }
      } catch(e){}

      imported++;
    });

    saveAfterImport();

    if (imported > 0) {
      toastSafe("✅ FVT Browser JSON içe aktarıldı: " + imported + " fon güncellendi.", "ok");
    } else {
      toastSafe("FVT Browser JSON okundu ama güncellenecek fon bulunamadı.", "err");
    }

    if (failed.length) {
      console.warn("[ORKA FVT IMPORT] Atlanan fonlar:", failed);
    }

    return { imported, failed };
  }

  async function importFile(file){
    var text = await file.text();
    var payload = JSON.parse(text);
    return importJsonObject(payload);
  }

  function pickFile(){
    var input = document.getElementById("orkaFvtBrowserJsonInput");
    if (!input) {
      input = document.createElement("input");
      input.id = "orkaFvtBrowserJsonInput";
      input.type = "file";
      input.accept = ".json,application/json";
      input.style.display = "none";
      document.body.appendChild(input);
    }

    input.onchange = async function(){
      try {
        if (!input.files || !input.files[0]) return;
        await importFile(input.files[0]);
      } catch(e) {
        console.error("[ORKA FVT IMPORT]", e);
        toastSafe("FVT JSON içe aktarma hatası: " + e.message, "err");
      } finally {
        input.value = "";
      }
    };

    input.click();
  }

  window.ORKA_FVT_IMPORT = {
    pickFile: pickFile,
    importFile: importFile,
    importJsonObject: importJsonObject
  };
})();
