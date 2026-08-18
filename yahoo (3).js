exports.handler = async function(event, context) {
  const ticker = event.queryStringParameters && event.queryStringParameters.ticker;
  const range  = (event.queryStringParameters && event.queryStringParameters.range) || '1d';

  if (!ticker) {
    return { statusCode: 400, body: JSON.stringify({ error: 'ticker required' }) };
  }

  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/'
    + encodeURIComponent(ticker)
    + '?interval=1d&range=' + encodeURIComponent(range);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      // query2 dene
      const url2 = url.replace('query1', 'query2');
      const r2 = await fetch(url2, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
      if (!r2.ok) return { statusCode: r2.status, body: JSON.stringify({ error: 'Yahoo HTTP ' + r2.status }) };
      const data2 = await r2.json();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify(data2)
      };
    }

    const data = await response.json();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(data)
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
