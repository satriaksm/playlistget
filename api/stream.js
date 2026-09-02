module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url, filename = 'download.mp3' } = req.query || {};

  if (!url) {
    return res.status(400).send('URL required');
  }

  try {
    const upstreamRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!upstreamRes.ok) {
      return res.status(upstreamRes.status).send('Failed to fetch media stream from upstream');
    }

    res.setHeader('Content-Type', upstreamRes.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);

    const contentLength = upstreamRes.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    const arrayBuffer = await upstreamRes.arrayBuffer();
    return res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    console.error('Stream proxy error:', err);
    return res.status(500).send('Stream proxy error: ' + err.message);
  }
};
