const spotifyUrlInfo = require('spotify-url-info')(fetch);

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function detectPlatformInfo(url) {
  const lower = url.toLowerCase();
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return { name: 'YouTube', type: 'yt' };
  if (lower.includes('spotify.com')) return { name: 'Spotify', type: 'sp' };
  if (lower.includes('tiktok.com') || lower.includes('douyin.com')) return { name: 'TikTok', type: 'tt' };
  if (lower.includes('instagram.com')) return { name: 'Instagram', type: 'ig' };
  if (lower.includes('facebook.com') || lower.includes('fb.watch')) return { name: 'Facebook', type: 'fb' };
  if (lower.includes('twitter.com') || lower.includes('x.com')) return { name: 'Twitter / X', type: 'tw' };
  if (lower.includes('soundcloud.com')) return { name: 'SoundCloud', type: 'sc' };
  return { name: 'Media Provider', type: 'generic' };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url } = req.body || req.query || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  let cleanUrl = url.trim();
  if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
    cleanUrl = 'https://' + cleanUrl;
  }

  try {
    new URL(cleanUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL. Please provide a valid web link.' });
  }

  const platformInfo = detectPlatformInfo(cleanUrl);
  const spotifyRegex = /^(https?:\/\/)?(www\.)?open\.spotify\.com\/(playlist|track|album|artist)\/.+/i;

  try {
    // 1. Handle Spotify URLs
    if (spotifyRegex.test(cleanUrl)) {
      try {
        const spotifyData = await spotifyUrlInfo.getData(cleanUrl);
        if (spotifyData) {
          if (spotifyData.type === 'track') {
            const artist = spotifyData.artists?.[0]?.name || spotifyData.artist || 'Unknown';
            const title = spotifyData.name || 'Spotify Track';
            let cover = spotifyData.coverArt?.sources?.[0]?.url || spotifyData.thumbnail || '';
            if (!cover) {
              const trackId = cleanUrl.match(/track\/([a-zA-Z0-9]+)/)?.[1];
              if (trackId) {
                try {
                  const oembedRes = await fetch(`https://open.spotify.com/oembed?url=https://open.spotify.com/track/${trackId}`);
                  if (oembedRes.ok) {
                    const oembedData = await oembedRes.json();
                    cover = oembedData?.thumbnail_url || '';
                  }
                } catch {}
              }
            }
            const durationSec = spotifyData.duration ? Math.floor(spotifyData.duration / 1000) : null;

            return res.json({
              title: `${title} - ${artist}`,
              platform: 'Spotify',
              platformType: 'sp',
              count: 1,
              videos: [{
                id: `spotify_track_${Date.now()}`,
                title: `${title} - ${artist}`,
                duration: durationSec,
                durationString: formatDuration(durationSec),
                thumbnail: cover,
                uploader: artist,
                url: `ytsearch1:${title} ${artist}`,
                platform: 'Spotify',
                platformType: 'sp',
                index: 1
              }]
            });
          } else if (spotifyData.trackList && spotifyData.trackList.length > 0) {
            const playlistCover = spotifyData.coverArt?.sources?.[0]?.url || spotifyData.thumbnail || '';
            const rawTracks = spotifyData.trackList.slice(0, 200);

            // Fetch distinct album art for each track in parallel
            const coverPromises = rawTracks.map(async (track) => {
              if (track.coverArt?.sources?.[0]?.url) {
                return track.coverArt.sources[0].url;
              }
              const trackId = track.uri ? track.uri.split(':').pop() : '';
              if (!trackId) return playlistCover;

              try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 2000);
                const oembedRes = await fetch(`https://open.spotify.com/oembed?url=https://open.spotify.com/track/${trackId}`, {
                  signal: controller.signal
                });
                clearTimeout(timeoutId);
                if (oembedRes.ok) {
                  const oembedData = await oembedRes.json();
                  if (oembedData && oembedData.thumbnail_url) {
                    return oembedData.thumbnail_url;
                  }
                }
              } catch {}
              return playlistCover;
            });

            const individualCovers = await Promise.all(coverPromises);

            const videos = rawTracks.map((track, index) => {
              const artist = track.subtitle || (track.artists?.[0]?.name) || spotifyData.name || 'Spotify Artist';
              const title = track.title || track.name || `Track ${index + 1}`;
              const cover = individualCovers[index] || playlistCover || '';
              const durationSec = track.duration ? Math.floor(track.duration / 1000) : null;

              return {
                id: track.uri || `spotify_track_${index + 1}_${Date.now()}`,
                title: `${title} - ${artist}`,
                duration: durationSec,
                durationString: formatDuration(durationSec),
                thumbnail: cover,
                uploader: artist,
                url: `ytsearch1:${title} ${artist}`,
                platform: 'Spotify',
                platformType: 'sp',
                index: index + 1
              };
            });

            return res.json({
              title: spotifyData.name || 'Spotify Playlist',
              platform: 'Spotify',
              platformType: 'sp',
              count: videos.length,
              videos
            });
          }
        }
      } catch (spotifyErr) {
        console.warn('Spotify metadata error:', spotifyErr.message);
        return res.status(400).json({ error: 'Could not fetch tracks from Spotify. Make sure the playlist or track is public.' });
      }
    }

    // 2. Handle TikTok URLs
    if (cleanUrl.includes('tiktok.com') || cleanUrl.includes('douyin.com')) {
      try {
        const tikwmRes = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(cleanUrl)}`);
        if (tikwmRes.ok) {
          const tikwmData = await tikwmRes.json();
          if (tikwmData.code === 0 && tikwmData.data) {
            const data = tikwmData.data;
            const title = data.title || `TikTok by ${data.author?.nickname || 'Creator'}`;
            const artist = data.author?.nickname || 'TikTok';
            const cover = data.cover || data.origin_cover || '';
            const durationSec = data.duration || null;

            return res.json({
              title: title,
              platform: 'TikTok',
              platformType: 'tt',
              count: 1,
              videos: [{
                id: data.id || `tiktok_${Date.now()}`,
                title: `${title} - ${artist}`,
                duration: durationSec,
                durationString: formatDuration(durationSec),
                thumbnail: cover,
                uploader: artist,
                url: cleanUrl,
                playUrl: data.play,
                musicUrl: data.music,
                platform: 'TikTok',
                platformType: 'tt',
                index: 1
              }]
            });
          }
        }
      } catch (tiktokErr) {
        console.warn('TikWM error:', tiktokErr.message);
      }

      // Fallback oEmbed for TikTok
      try {
        const oembedRes = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(cleanUrl)}`);
        if (oembedRes.ok) {
          const oembedData = await oembedRes.json();
          if (oembedData && (oembedData.title || oembedData.author_name)) {
            const title = oembedData.title || `TikTok by ${oembedData.author_name}`;
            return res.json({
              title: title,
              platform: 'TikTok',
              platformType: 'tt',
              count: 1,
              videos: [{
                id: `tiktok_${Date.now()}`,
                title: `${title} - ${oembedData.author_name || 'TikTok'}`,
                duration: null,
                durationString: '--:--',
                thumbnail: oembedData.thumbnail_url || '',
                uploader: oembedData.author_name || 'TikTok',
                url: cleanUrl,
                platform: 'TikTok',
                platformType: 'tt',
                index: 1
              }]
            });
          }
        }
      } catch {}
    }

    // 3. Handle YouTube & YouTube Music
    if (cleanUrl.includes('youtube.com') || cleanUrl.includes('youtu.be')) {
      const parsed = new URL(cleanUrl);
      const listId = parsed.searchParams.get('list');

      // Check if it's a playlist
      if (listId && !listId.startsWith('RD') && !listId.startsWith('LL')) {
        try {
          const ytHtmlRes = await fetch(`https://www.youtube.com/playlist?list=${listId}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
            }
          });

          if (ytHtmlRes.ok) {
            const html = await ytHtmlRes.text();
            const idx = html.indexOf('ytInitialData = ');
            if (idx !== -1) {
              const end = html.indexOf(';</script>', idx);
              const json = JSON.parse(html.substring(idx + 16, end));

              function extractLockups(o, list = []) {
                if (!o || typeof o !== 'object') return list;
                if (o.contentImage?.thumbnailViewModel || o.lockupMetadataViewModel) {
                  const title = o.metadata?.lockupMetadataViewModel?.title?.content;
                  const id = o.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.videoId
                    || o.contentImage?.thumbnailViewModel?.image?.sources?.[0]?.url?.match(/\/vi\/([a-zA-Z0-9_-]{11})\//)?.[1];
                  const uploader = o.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || 'YouTube';
                  if (title || id) {
                    list.push({ id, title, uploader });
                  }
                }
                for (const k in o) extractLockups(o[k], list);
                return list;
              }

              const rawItems = extractLockups(json);
              if (rawItems.length > 0) {
                // Deduplicate by ID
                const seen = new Set();
                const uniqueItems = rawItems.filter(item => {
                  if (!item.id || seen.has(item.id)) return false;
                  seen.add(item.id);
                  return true;
                });

                const playlistTitle = json.header?.playlistHeaderRenderer?.title?.simpleText
                  || json.metadata?.playlistMetadataRenderer?.title
                  || 'YouTube Playlist';

                const videos = uniqueItems.map((item, index) => {
                  return {
                    id: item.id,
                    title: item.title ? `${item.title} - ${item.uploader}` : `Video ${index + 1}`,
                    duration: null,
                    durationString: '--:--',
                    thumbnail: item.id ? `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg` : '',
                    uploader: item.uploader || 'YouTube',
                    url: `https://www.youtube.com/watch?v=${item.id}`,
                    platform: 'YouTube',
                    platformType: 'yt',
                    index: index + 1
                  };
                });

                return res.json({
                  title: playlistTitle,
                  platform: 'YouTube',
                  platformType: 'yt',
                  count: videos.length,
                  videos
                });
              }
            }
          }
        } catch (ytPlErr) {
          console.warn('YouTube playlist scraping error:', ytPlErr.message);
        }
      }

      // Single YouTube Video via oEmbed
      try {
        const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(cleanUrl)}&format=json`);
        if (oembedRes.ok) {
          const oembedData = await oembedRes.json();
          if (oembedData && (oembedData.title || oembedData.author_name)) {
            let videoId = '';
            const match = cleanUrl.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/i);
            if (match) videoId = match[1];

            const track = {
              id: videoId || cleanUrl,
              title: `${oembedData.title || 'YouTube Video'} - ${oembedData.author_name || 'YouTube'}`,
              artist: oembedData.author_name || 'YouTube',
              duration: null,
              durationString: '--:--',
              thumbnail: oembedData.thumbnail_url || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : ''),
              uploader: oembedData.author_name || 'YouTube',
              url: cleanUrl,
              platform: 'YouTube',
              platformType: 'yt',
              index: 1
            };
            return res.json({
              title: oembedData.title || 'YouTube Video',
              platform: 'YouTube',
              platformType: 'yt',
              count: 1,
              videos: [track]
            });
          }
        }
      } catch (ytOembedErr) {
        console.warn('YouTube single oembed error:', ytOembedErr.message);
      }
    }

    // 4. Handle Instagram Reels & Posts
    if (cleanUrl.includes('instagram.com')) {
      const match = cleanUrl.match(/(?:p|reel|reels|tv)\/([a-zA-Z0-9_-]+)/i);
      const shortcode = match ? match[1] : '';
      const title = shortcode ? `Instagram Media (${shortcode})` : 'Instagram Post';

      return res.json({
        title: title,
        platform: 'Instagram',
        platformType: 'ig',
        count: 1,
        videos: [{
          id: `ig_${shortcode || Date.now()}`,
          title: title,
          duration: null,
          durationString: '--:--',
          thumbnail: '',
          uploader: 'Instagram Creator',
          url: cleanUrl,
          platform: 'Instagram',
          platformType: 'ig',
          index: 1
        }]
      });
    }

    // 5. Handle other platforms via generic fallback
    return res.json({
      title: `${platformInfo.name} Media`,
      platform: platformInfo.name,
      platformType: platformInfo.type,
      count: 1,
      videos: [{
        id: `media_${Date.now()}`,
        title: `${platformInfo.name} Media Download`,
        duration: null,
        durationString: '--:--',
        thumbnail: '',
        uploader: platformInfo.name,
        url: cleanUrl,
        platform: platformInfo.name,
        platformType: platformInfo.type,
        index: 1
      }]
    });

  } catch (err) {
    console.error('Playlist fetch error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};
