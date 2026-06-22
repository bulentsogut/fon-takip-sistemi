// api/tefas.js - Vercel
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const { endpoint, body: reqBody } = typeof body === 'string' ? JSON.parse(body) : body;
    const url = 'https://www.tefas.gov.tr/api/funds/' + endpoint;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://www.tefas.gov.tr',
        'Referer': 'https://www.tefas.gov.tr/'
      },
      body: JSON.stringify(reqBody)
    });

    if (!response.ok) {
      res.status(response.status).json({ error: 'TEFAS HTTP ' + response.status });
      return;
    }

    const data = await response.json();
    res.status(200).json(data);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
