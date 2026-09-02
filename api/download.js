function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '').trim().substring(0, 100);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url, format = 'mp3', quality = '320k', title = 'media', playUrl, musicUrl } = req.body || req.query || {};

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  const cleanTitle = sanitizeFilename(title || 'download');
  const ext = format === 'mp4' ? 'mp4' : 'mp3';
  const filename = `${cleanTitle}.${ext}`;

  try {
    // 1. TikTok direct streams if provided or fetch from TikWM
    if (playUrl || musicUrl) {
      const downloadUrl = (format === 'mp3' && musicUrl) ? musicUrl : (playUrl || musicUrl);
      return res.json({
        success: true,
        downloadUrl,
        filename,
        platform: 'TikTok'
      });
    }

    if (url.includes('tiktok.com') || url.includes('douyin.com')) {
      try {
        const tikRes = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`);
        if (tikRes.ok) {
          const tikData = await tikRes.json();
          if (tikData.code === 0 && tikData.data) {
            const downloadUrl = (format === 'mp3' && tikData.data.music) ? tikData.data.music : tikData.data.play;
            return res.json({
              success: true,
              downloadUrl,
              filename,
              platform: 'TikTok'
            });
          }
        }
      } catch (err) {
        console.warn('TikWM error:', err.message);
      }
    }

    // 2. Cobalt API Engine (Public Instances / Custom Instance)
    const cobaltInstances = [
      process.env.COBALT_API_URL,
      'https://cobalt.api.kwiatekm.tokyo',
      'https://cobalt-api.kwiatekm.tokyo',
      'https://api.cobalt.tools'
    ].filter(Boolean);

    let targetUrl = url;
    if (targetUrl.startsWith('ytsearch1:')) {
      // If it's a Spotify search query, we can format search query or resolve
      targetUrl = targetUrl.replace('ytsearch1:', '').trim();
    }

    for (const instance of cobaltInstances) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        const cobaltRes = await fetch(instance.endsWith('/') ? instance : instance + '/', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0'
          },
          body: JSON.stringify({
            url: targetUrl,
            downloadMode: format === 'mp4' ? 'auto' : 'audio',
            audioFormat: format === 'mp3' ? 'mp3' : 'best',
            videoQuality: quality === '1080p' ? '1080' : '720'
          }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (cobaltRes.ok) {
          const cobaltData = await cobaltRes.json();
          if (cobaltData.url || cobaltData.audio) {
            return res.json({
              success: true,
              downloadUrl: cobaltData.url || cobaltData.audio,
              filename,
              platform: 'CloudAPI'
            });
          }
        }
      } catch (cobaltErr) {
        // Try next instance
      }
    }

    // 3. Fallback: Proxy stream URL or Direct Stream Link
    return res.json({
      success: true,
      downloadUrl: `/api/stream?url=${encodeURIComponent(targetUrl)}&format=${format}&filename=${encodeURIComponent(filename)}`,
      filename,
      direct: false
    });

  } catch (err) {
    console.error('Download resolve error:', err);
    res.status(500).json({ error: 'Download failed: ' + err.message });
  }
};
