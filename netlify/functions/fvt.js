exports.handler = async function(event, context) {
  const fonKodu = event.queryStringParameters && event.queryStringParameters.fon;

  if (!fonKodu) {
    return { statusCode: 400, body: JSON.stringify({ error: 'fon parametresi gerekli' }) };
  }

  const url = 'https://fvt.com.tr/api/funds/' + fonKodu.toUpperCase() + '/distribution';

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://fvt.com.tr/',
        'Origin': 'https://fvt.com.tr'
      }
    });

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: 'FVT HTTP ' + response.status })
      };
    }

    const data = await response.json();

    // items dizisinden hisse bilgilerini çıkar
    var items = (data.data && data.data.items) || [];
    var holdings = items
      .filter(function(item) { return item.hisseKodu && item.hisseKodu.trim() !== ''; })
      .map(function(item) {
        return {
          kod: item.hisseKodu.trim(),
          ad: (item.sirketAdi || '').trim(),
          agirlik: parseFloat(item.agirlik) || 0,
          sektor: item.sektor || '',
          etf: item.etf === 1,
          yabanci: item.yabanci === 1
        };
      })
      .sort(function(a, b) { return b.agirlik - a.agirlik; });

    var meta = (data.data && data.data.meta) || {};

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600' // 1 saat cache
      },
      body: JSON.stringify({
        fon: fonKodu.toUpperCase(),
        holdings: holdings,
        aciklamaTarihi: meta.aciklamaTarihi || '',
        toplamAgirlik: holdings.reduce(function(s, h) { return s + h.agirlik; }, 0)
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
