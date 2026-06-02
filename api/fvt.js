// api/fvt.js - Vercel
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const fonKodu = req.query.fon;
  const istek   = req.query.istek;

  if (!fonKodu) {
    res.status(400).json({ error: 'fon parametresi gerekli' });
    return;
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Referer': 'https://fvt.com.tr/',
    'Origin': 'https://fvt.com.tr'
  };

  // Gunluk getiri istegi
  if (istek === 'getiri') {
    try {
      // Once /api/funds/ dene, 404 gelirse /api/stocks/ dene (BYF fonlar icin)
      let fonUrl = 'https://fvt.com.tr/api/funds/' + fonKodu.toUpperCase();
      let response = await fetch(fonUrl, { headers });
      if (!response.ok) {
        // BYF endpoint dene
        fonUrl = 'https://fvt.com.tr/api/stocks/' + fonKodu.toUpperCase();
        response = await fetch(fonUrl, { headers });
      }
      // Asagidaki response.ok kontrolu icin response'u override et
      const _response = response;
      if (!_response.ok) { res.status(_response.status).json({ error: 'FVT HTTP ' + _response.status }); return; }
      const data = await _response.json();
      const priceHistory = data.data && data.data.priceHistory;
      let dailyReturn = null;
      if (priceHistory && priceHistory.length >= 2) {
        const todayPrice = parseFloat(priceHistory[0].fiyat);
        const yesterdayPrice = parseFloat(priceHistory[1].fiyat);
        if (yesterdayPrice > 0) {
          dailyReturn = parseFloat(((todayPrice - yesterdayPrice) / yesterdayPrice * 100).toFixed(4));
        }
      }
      const fonData = (data.data && data.data.fund) ? data.data.fund : (data.data || {});
      if (dailyReturn === null && fonData.getiri) dailyReturn = parseFloat(fonData.getiri);
      res.status(200).json({ fon: fonKodu.toUpperCase(), dailyReturn });
      return;
    } catch (err) {
      res.status(500).json({ error: err.message });
      return;
    }
  }

  // Portfoy dagılımı
  const url = 'https://fvt.com.tr/api/funds/' + fonKodu.toUpperCase() + '/distribution';
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) { res.status(response.status).json({ error: 'FVT HTTP ' + response.status }); return; }
    const data = await response.json();
    const items = (data.data && data.data.items) || [];

    const holdings = items
      .filter(item => item.hisseKodu && item.hisseKodu.trim() !== '')
      .map(item => {
        const kod = item.hisseKodu.trim();
        let tip;
        const sirketAdi = (item.sirketAdi || '').trim();
        if (item.etf === 1) {
          tip = 'fund'; // FVT'de etf=1 yatirim fonu demek
        } else if (kod.match(/[0-9]F[0-9]?$/) || kod.match(/^[A-Z]{2,4}[0-9]F/)) {
          tip = 'fund'; // TPKGYF1 gibi fon kodu pattern
        } else if (sirketAdi === '' && item.yabanci === 0) {
          tip = 'fund'; // Isim bos + yerli = yatirim fonu
        } else if (item.yabanci === 1) {
          tip = 'us';
        } else {
          tip = 'bist';
        }
        return {
          kod, tip,
          ad: (item.sirketAdi || '').trim(),
          agirlik: parseFloat(item.agirlik) || 0,
          sektor: item.sektor || '',
          etf: item.etf === 1,
          yabanci: item.yabanci === 1
        };
      })
      .filter(h => h.agirlik > 0)
      .sort((a, b) => b.agirlik - a.agirlik);

    const meta = (data.data && data.data.meta) || {};
    res.status(200).json({
      fon: fonKodu.toUpperCase(),
      holdings,
      aciklamaTarihi: meta.aciklamaTarihi || '',
      toplamAgirlik: holdings.reduce((s, h) => s + h.agirlik, 0)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
