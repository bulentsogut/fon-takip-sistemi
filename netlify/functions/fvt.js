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
    // Fon kodu tespiti: 3 harf veya fon kategorisi
    var FON_KATEGORILERI = [22, 23, 24, 25, 26, 27, 28]; // hisseKategori fon kodlari
    
    var holdings = items
      .filter(function(item) { return item.hisseKodu && item.hisseKodu.trim() !== ''; })
      .map(function(item) {
        var kod = item.hisseKodu.trim();
        var agirlik = parseFloat(item.agirlik) || 0;
        
        // Tip tespiti
        var tip;
        if (item.etf === 1) {
          tip = 'etf';
        } else if (FON_KATEGORILERI.indexOf(item.hissekategori) !== -1 
                   || kod.match(/^[A-Z]{2,4}[0-9]?F[0-9]?$/)  // TPKGYF1 gibi
                   || kod.match(/^[A-Z]{3}[0-9]$/)              // TI1, RS1, CFO gibi kisa kodlar
                   || kod.length <= 3 && !item.yabanci) {        // 3 harf, yerli = muhtemelen fon
          tip = 'fund';
        } else if (item.yabanci === 1) {
          tip = 'us';
        } else {
          tip = 'bist';
        }
        
        return {
          kod: kod,
          ad: (item.sirketAdi || '').trim(),
          agirlik: agirlik,
          sektor: item.sektor || '',
          tip: tip,
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
