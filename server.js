require('dotenv').config();
const express = require('express');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');
const ffmpegStatic = require('ffmpeg-static');
const spotifyUrlInfo = require('spotify-url-info')(fetch);
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust reverse proxy (Cloudflare, Nginx, Railway, Render, etc.)
app.set('trust proxy', 1);

// ── Security & Resource Limits ─────────────────────────────────────
const LIMITS = {
  MAX_PLAYLIST_SIZE: parseInt(process.env.MAX_PLAYLIST_SIZE, 10) || 200,
  MAX_CONCURRENT_SESSIONS: parseInt(process.env.MAX_CONCURRENT_SESSIONS, 10) || 5,
  CONCURRENT_DOWNLOADS_PER_SESSION: parseInt(process.env.CONCURRENT_DOWNLOADS_PER_SESSION, 10) || 2,
  SESSION_TTL_MS: (parseInt(process.env.SESSION_TTL_MINUTES, 10) || 30) * 60 * 1000,
  ORPHAN_TTL_MS: (parseInt(process.env.ORPHAN_TTL_MINUTES, 10) || 60) * 60 * 1000,
  CLEANUP_INTERVAL_MS: 5 * 60 * 1000,
  RATE_LIMIT_WINDOW_MS: 60 * 1000,
  RATE_LIMIT_MAX_REQUESTS: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 20,
  MAX_BODY_SIZE: '100kb',
  ALLOWED_FORMATS: ['mp3', 'mp4'],
  ALLOWED_QUALITIES: ['128k', '192k', '256k', '320k', '480p', '720p', '1080p', 'best'],
  COOKIES_PATH: process.env.YTDLP_COOKIES_PATH || null,
};

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateSessionId(req, res, next) {
  const { sessionId } = req.params;
  if (!sessionId || !UUID_REGEX.test(sessionId)) {
    return res.status(400).json({ error: 'Invalid or malformed session ID' });
  }
  next();
}

// ── Simple rate limiter (per-IP, in-memory) ────────────────────────
const rateLimitStore = new Map();
function rateLimit(req, res, next) {
  if (req.method !== 'POST') {
    return next();
  }
  const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  if (!rateLimitStore.has(ip)) {
    rateLimitStore.set(ip, []);
  }
  const timestamps = rateLimitStore.get(ip).filter(t => now - t < LIMITS.RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= LIMITS.RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  }
  timestamps.push(now);
  rateLimitStore.set(ip, timestamps);
  next();
}

// Clean up old rate limit entries every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateLimitStore.entries()) {
    const fresh = timestamps.filter(t => now - t < LIMITS.RATE_LIMIT_WINDOW_MS);
    if (fresh.length === 0) rateLimitStore.delete(ip);
    else rateLimitStore.set(ip, fresh);
  }
}, 2 * 60 * 1000);

// ── Security Headers & CORS ─────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*';
app.use(cors({
  origin: allowedOrigins === '*' ? '*' : allowedOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Middleware
app.use(express.json({ limit: LIMITS.MAX_BODY_SIZE }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(rateLimit);

// Explicit root route for Codespaces/Docker environments
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Store for download sessions
const sessions = new Map();

// Ensure downloads directory exists (with fallback to OS tmpdir for serverless/restricted environments)
let DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || path.join(__dirname, 'downloads');
try {
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  }
} catch (err) {
  // Read-only filesystem fallback
  DOWNLOADS_DIR = path.join(os.tmpdir(), 'playlistget-downloads');
  try {
    if (!fs.existsSync(DOWNLOADS_DIR)) {
      fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    }
  } catch {}
}

// Universal yt-dlp execution helper
function getYtDlpCommandInfo() {
  const candidates = [
    { cmd: 'yt-dlp', baseArgs: [] },
    { cmd: '/usr/local/bin/yt-dlp', baseArgs: [] },
    { cmd: 'python3', baseArgs: ['/usr/local/bin/yt-dlp'] },
    { cmd: 'python3', baseArgs: ['-m', 'yt_dlp'] },
    { cmd: 'python', baseArgs: ['/usr/local/bin/yt-dlp'] },
    { cmd: 'python', baseArgs: ['-m', 'yt_dlp'] },
    { cmd: '/usr/bin/yt-dlp', baseArgs: [] },
    { cmd: path.join(os.homedir(), '.local/bin/yt-dlp'), baseArgs: [] },
    { cmd: 'py', baseArgs: ['-m', 'yt_dlp'] }
  ];

  for (const c of candidates) {
    try {
      if (c.baseArgs.length > 0) {
        execSync(`${c.cmd} ${c.baseArgs.join(' ')} --version`, { encoding: 'utf-8', stdio: 'pipe' });
      } else {
        execSync(`${c.cmd} --version`, { encoding: 'utf-8', stdio: 'pipe' });
      }
      return c;
    } catch {}
  }

  return { cmd: 'yt-dlp', baseArgs: [] };
}

function spawnYtDlp(args) {
  const { cmd, baseArgs } = getYtDlpCommandInfo();
  return spawn(cmd, [...baseArgs, ...args]);
}

function execYtDlpSync(argsStr) {
  const { cmd, baseArgs } = getYtDlpCommandInfo();
  if (baseArgs.length > 0) {
    return execSync(`${cmd} ${baseArgs.join(' ')} ${argsStr}`, { encoding: 'utf-8', stdio: 'pipe' });
  }
  return execSync(`${cmd} ${argsStr}`, { encoding: 'utf-8', stdio: 'pipe' });
}

// Check if yt-dlp is available
function checkYtDlp() {
  try {
    const out = execYtDlpSync('--version');
    return !!(out && out.trim());
  } catch {
    return false;
  }
}

// Auto-download yt-dlp on Linux/Codespaces if missing
function ensureYtDlpAvailable() {
  if (checkYtDlp()) return true;

  if (process.platform === 'linux') {
    try {
      console.log('  ⬇️ yt-dlp not detected. Installing standalone binary...');
      const targetDir = path.join(os.homedir(), '.local', 'bin');
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      const targetPath = path.join(targetDir, 'yt-dlp');
      execSync(`curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "${targetPath}" && chmod a+rx "${targetPath}"`, { stdio: 'pipe' });
      if (checkYtDlp()) {
        console.log(`  ✅ yt-dlp installed automatically to ${targetPath}`);
        return true;
      }
    } catch (autoErr) {
      console.warn(`  ⚠️ Auto-install of yt-dlp failed: ${autoErr.message}`);
    }
  }
  return false;
}

// Check if ffmpeg is available
function checkFfmpeg() {
  if (ffmpegStatic) return true;
  try {
    execSync('ffmpeg -version', { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Detect media platform for UI enrichment
function detectPlatformInfo(url) {
  const u = (url || '').toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return { name: 'YouTube', type: 'yt' };
  if (u.includes('spotify.com')) return { name: 'Spotify', type: 'sp' };
  if (u.includes('tiktok.com')) return { name: 'TikTok', type: 'tt' };
  if (u.includes('instagram.com')) return { name: 'Instagram', type: 'ig' };
  if (u.includes('facebook.com') || u.includes('fb.watch') || u.includes('fb.com')) return { name: 'Facebook', type: 'fb' };
  if (u.includes('twitter.com') || u.includes('x.com')) return { name: 'Twitter / X', type: 'tw' };
  if (u.includes('soundcloud.com')) return { name: 'SoundCloud', type: 'sc' };
  if (u.includes('reddit.com') || u.includes('redd.it')) return { name: 'Reddit', type: 'rd' };
  if (u.includes('vimeo.com')) return { name: 'Vimeo', type: 'vm' };
  if (u.includes('pinterest.com') || u.includes('pin.it')) return { name: 'Pinterest', type: 'pt' };
  if (u.includes('twitch.tv')) return { name: 'Twitch', type: 'twc' };
  if (u.includes('threads.net')) return { name: 'Threads', type: 'th' };
  if (u.includes('bilibili.com') || u.includes('b23.tv')) return { name: 'Bilibili', type: 'bi' };
  if (u.includes('dailymotion.com') || u.includes('dai.ly')) return { name: 'Dailymotion', type: 'dm' };
  return { name: 'Universal Media', type: 'generic' };
}

// API: Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    activeSessions: [...sessions.values()].filter(s => s.status === 'downloading').length,
    ytDlpAvailable: checkYtDlp(),
    ffmpegAvailable: checkFfmpeg()
  });
});

// API: Check system requirements
app.get('/api/check', (req, res) => {
  const ytDlpAvailable = checkYtDlp();
  const ffmpegAvailable = checkFfmpeg();
  let ytDlpVersion = null;
  if (ytDlpAvailable) {
    try {
      ytDlpVersion = execYtDlpSync('--version').trim();
    } catch {}
  }
  res.json({
    ytDlpAvailable,
    ffmpegAvailable,
    ytDlpVersion,
    message: !ytDlpAvailable
      ? 'yt-dlp is not installed. Please install it: pip install yt-dlp'
      : !ffmpegAvailable
        ? 'ffmpeg is not installed. MP3 conversion will not work, but direct download will work.'
        : 'System ready!'
  });
});

// Helper to run yt-dlp metadata extraction
function extractYtDlpMetadata(args) {
  return new Promise((resolve, reject) => {
    const ytdlp = spawnYtDlp(args);
    let output = '';
    let errorOutput = '';

    ytdlp.stdout.on('data', (data) => {
      output += data.toString();
    });

    ytdlp.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    ytdlp.on('close', (code) => {
      resolve({ code, output, errorOutput });
    });

    ytdlp.on('error', (err) => {
      reject(err);
    });
  });
}

// API: Fetch playlist / media info (Supports YouTube, Spotify, TikTok, Instagram, Facebook, Twitter, SoundCloud, etc.)
app.post('/api/playlist', async (req, res) => {
  const { url } = req.body;

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

  // Reject URLs that are suspiciously long
  if (cleanUrl.length > 1000) {
    return res.status(400).json({ error: 'URL is too long.' });
  }

  // Normalize YouTube Music & YouTube playlist URLs for complete full-playlist extraction
  let targetUrl = cleanUrl;
  try {
    const parsed = new URL(cleanUrl);
    if (parsed.hostname.includes('youtube.com') || parsed.hostname.includes('youtu.be')) {
      const listId = parsed.searchParams.get('list');
      if (listId && !listId.startsWith('RD') && !listId.startsWith('LL')) {
        targetUrl = `https://www.youtube.com/playlist?list=${listId}`;
      } else if (parsed.hostname.includes('music.youtube.com') && parsed.pathname.includes('/playlist')) {
        targetUrl = cleanUrl.replace('music.youtube.com', 'www.youtube.com');
      }
    }
  } catch {}

  const platformInfo = detectPlatformInfo(cleanUrl);
  const spotifyRegex = /^(https?:\/\/)?(www\.)?open\.spotify\.com\/(playlist|track|album|artist)\/.+/i;

  // Instant Spotify metadata resolution with individual track covers
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
          const rawTracks = spotifyData.trackList.slice(0, LIMITS.MAX_PLAYLIST_SIZE || 200);

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

  try {
    let args = [
      '--flat-playlist',
      '--dump-json',
      '--yes-playlist',
      '--compat-options', 'no-youtube-unavailable-videos',
      '--playlist-end', String(LIMITS.MAX_PLAYLIST_SIZE || 200),
      '--no-warnings',
      '--ignore-errors',
      '--no-check-certificates',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      '--extractor-args', 'youtube:player_client=android'
    ];

    if (LIMITS.COOKIES_PATH && fs.existsSync(LIMITS.COOKIES_PATH)) {
      args.push('--cookies', LIMITS.COOKIES_PATH);
    }

    let customTitle = null;
    let spotifyData = null;

    args.push('--', targetUrl);

    let { output, errorOutput } = await extractYtDlpMetadata(args);

    // If flat-playlist produced no output and not Spotify, attempt deep extraction (e.g. single TikTok / Instagram / Facebook / YouTube posts)
    if (!output.trim() && !spotifyData) {
      const fallbackArgs = [
        '--dump-json',
        '--no-playlist',
        '--no-warnings',
        '--ignore-errors',
        '--no-check-certificates',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        '--extractor-args', 'youtube:player_client=android'
      ];
      if (LIMITS.COOKIES_PATH && fs.existsSync(LIMITS.COOKIES_PATH)) {
        fallbackArgs.push('--cookies', LIMITS.COOKIES_PATH);
      }
      fallbackArgs.push('--', targetUrl);

      const fallbackResult = await extractYtDlpMetadata(fallbackArgs);
      if (fallbackResult.output.trim()) {
        output = fallbackResult.output;
        errorOutput = fallbackResult.errorOutput;
      }
    }

    // YouTube direct oEmbed fallback if datacenter IP is rate-limited (for SINGLE video only, not playlist)
    const isPlaylistUrl = cleanUrl.includes('list=') || cleanUrl.includes('/playlist') || cleanUrl.includes('/album') || cleanUrl.includes('/sets/');
    if (!output.trim() && !isPlaylistUrl && (cleanUrl.includes('youtube.com') || cleanUrl.includes('youtu.be'))) {
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
              title: oembedData.title || 'YouTube Video',
              artist: oembedData.author_name || 'YouTube',
              duration: 0,
              thumbnail: oembedData.thumbnail_url || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null),
              url: cleanUrl,
              platform: 'YouTube'
            };
            return res.json({
              title: track.title,
              platform: 'YouTube',
              total: 1,
              videos: [track]
            });
          }
        }
      } catch (ytOembedErr) {
        console.warn('YouTube oEmbed fallback failed:', ytOembedErr.message);
      }
    }

    // TikTok direct oEmbed fallback if scraping was rate-limited
    if (!output.trim() && (cleanUrl.includes('tiktok.com') || cleanUrl.includes('douyin.com'))) {
      try {
        const oembedRes = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(cleanUrl)}`);
        if (oembedRes.ok) {
          const oembedData = await oembedRes.json();
          if (oembedData && (oembedData.title || oembedData.author_name)) {
            const track = {
              id: cleanUrl,
              title: oembedData.title || `TikTok by ${oembedData.author_name || 'Creator'}`,
              artist: oembedData.author_name || 'TikTok',
              duration: 0,
              thumbnail: oembedData.thumbnail_url || null,
              url: cleanUrl,
              platform: 'TikTok'
            };
            return res.json({
              title: track.title,
              platform: 'TikTok',
              total: 1,
              videos: [track]
            });
          }
        }
      } catch (oembedErr) {
        console.warn('TikTok oEmbed fallback failed:', oembedErr.message);
      }
    }

    if (!output.trim()) {
      const isBotCheck = errorOutput.includes('Sign in to confirm') || errorOutput.includes('bot') || errorOutput.includes('login_required');
      const isGeoBlocked = errorOutput.includes('not available in your country') || errorOutput.includes('geo restriction');
      const isPrivate = errorOutput.includes('Private video') || errorOutput.includes('login') || errorOutput.includes('Private');

      let userFriendlyError = `Could not fetch media from ${platformInfo.name}. Make sure the link is public and accessible.`;
      if (isBotCheck) {
        userFriendlyError = `${platformInfo.name} requires verification or cookies. Please try another link or configure cookies.txt.`;
      } else if (isGeoBlocked) {
        userFriendlyError = `This media from ${platformInfo.name} is geo-restricted in this server region.`;
      } else if (isPrivate) {
        userFriendlyError = `This post or video on ${platformInfo.name} is private or requires logging in.`;
      }

      return res.status(400).json({
        error: userFriendlyError,
        details: errorOutput
      });
    }

    const entries = output.trim().split('\n').map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);

    if (entries.length === 0) {
      return res.status(400).json({ error: `No downloadable media found on ${platformInfo.name}.` });
    }

    // Extract title
    const playlistTitle = customTitle
      || entries[0].playlist_title
      || entries[0].playlist
      || entries[0].title
      || entries[0].fulltitle
      || entries[0].description?.substring(0, 50)
      || `${platformInfo.name} Media`;

    const videos = entries.map((entry, index) => {
      let rawTitle = entry.title || entry.fulltitle || entry.description?.substring(0, 80) || `Media ${index + 1}`;
      let rawUploader = entry.uploader || entry.channel || entry.artist || entry.creator || entry.uploader_id || platformInfo.name;

      if (spotifyData) {
        if (spotifyData.type === 'track') {
          rawTitle = spotifyData.name;
          rawUploader = spotifyData.artists?.[0]?.name || rawUploader;
        } else if (spotifyData.trackList && spotifyData.trackList[index]) {
          rawTitle = spotifyData.trackList[index].title;
          rawUploader = spotifyData.trackList[index].subtitle || rawUploader;
        }
      }

      // If uploader is missing or generic, attempt parsing "Artist - Title" from rawTitle
      if ((!rawUploader || rawUploader === platformInfo.name) && rawTitle.includes(' - ')) {
        const parts = rawTitle.split(' - ');
        rawUploader = parts[0].trim();
      }

      // Clean uploader name
      const cleanArtist = rawUploader
        ? rawUploader.replace(/\s*-\s*Topic$/i, '').replace(/\s*VEVO$/i, '').trim()
        : platformInfo.name;

      // Build display title as "Judul - Penyanyi" if not already present
      let displayTitle = rawTitle;
      if (cleanArtist && cleanArtist !== 'Unknown' && cleanArtist.toLowerCase() !== 'various artists' && cleanArtist !== platformInfo.name) {
        if (!rawTitle.toLowerCase().includes(cleanArtist.toLowerCase())) {
          displayTitle = `${rawTitle} - ${cleanArtist}`;
        }
      }

      // Determine robust thumbnail
      let thumbUrl = entry.thumbnail || entry.thumbnails?.[entry.thumbnails.length - 1]?.url;
      if (!thumbUrl && platformInfo.type === 'yt' && entry.id) {
        thumbUrl = `https://img.youtube.com/vi/${entry.id}/mqdefault.jpg`;
      }

      // Determine direct webpage url
      let directUrl = entry.webpage_url || (entry.url && entry.url.startsWith('http') ? entry.url : null);
      if (!directUrl) {
        if (platformInfo.type === 'yt' && entry.id) {
          directUrl = `https://www.youtube.com/watch?v=${entry.id}`;
        } else {
          directUrl = cleanUrl;
        }
      }

      return {
        id: entry.id || entry.url || `track_${index + 1}_${Date.now()}`,
        title: displayTitle,
        duration: entry.duration || null,
        durationString: entry.duration_string || formatDuration(entry.duration),
        thumbnail: thumbUrl || '',
        uploader: cleanArtist || platformInfo.name,
        url: directUrl,
        platform: platformInfo.name,
        platformType: platformInfo.type,
        index: index + 1
      };
    });

    res.json({
      title: playlistTitle,
      platform: platformInfo.name,
      platformType: platformInfo.type,
      count: videos.length,
      videos
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// API: Cancel / Cleanup
app.post('/api/cancel/:sessionId', validateSessionId, (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (session) {
    session.status = 'cancelled';
    if (session.activeProcesses && session.activeProcesses.length > 0) {
      session.activeProcesses.forEach(proc => {
        try { proc.kill('SIGTERM'); } catch {}
      });
    }
    cleanupSession(session.id);
    sessions.delete(session.id);
  }
  res.json({ success: true });
});

// API: Start batch download
app.post('/api/download', (req, res) => {
  const { videos } = req.body;

  if (!videos || !Array.isArray(videos) || videos.length === 0) {
    return res.status(400).json({ error: 'No videos selected for download.' });
  }

  // Cap playlist size
  if (videos.length > LIMITS.MAX_PLAYLIST_SIZE) {
    return res.status(400).json({ error: `Maximum ${LIMITS.MAX_PLAYLIST_SIZE} videos per download batch. You selected ${videos.length}.` });
  }

  // Validate format & quality
  const format = LIMITS.ALLOWED_FORMATS.includes(req.body.format) ? req.body.format : 'mp3';
  const quality = LIMITS.ALLOWED_QUALITIES.includes(req.body.quality) ? req.body.quality : 'best';

  // Limit concurrent sessions
  const activeSessions = [...sessions.values()].filter(s => s.status === 'downloading').length;
  if (activeSessions >= LIMITS.MAX_CONCURRENT_SESSIONS) {
    return res.status(429).json({ error: 'Server is currently busy. Please wait for ongoing downloads to complete.' });
  }

  const sessionId = uuidv4();
  const sessionDir = path.join(DOWNLOADS_DIR, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const ffmpegAvailable = checkFfmpeg();

  const session = {
    id: sessionId,
    totalVideos: videos.length,
    completed: 0,
    failed: 0,
    currentVideo: '',
    currentProgress: 0,
    currentSpeed: '',
    currentEta: '',
    status: 'downloading',
    progress: 0,
    files: [],
    errors: [],
    downloadedTitles: [],
    format,
    ffmpegAvailable,
    activeProcesses: [],
    createdAt: Date.now(),
    completedAt: null
  };

  sessions.set(sessionId, session);

  // Start concurrent worker download in background
  downloadVideosConcurrently(session, videos, sessionDir, format, quality);

  res.json({ sessionId, message: 'Download started' });
});

// API: Check download progress
app.get('/api/progress/:sessionId', validateSessionId, (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }
  const total = session.totalVideos || 0;
  const done = (session.completed || 0) + (session.failed || 0);
  const currentProgress = session.currentProgress || 0;

  let overallProgress = 0;
  if (total > 0) {
    if (session.status === 'completed') {
      overallProgress = 100;
    } else {
      const fractionalDone = done + (currentProgress / 100);
      overallProgress = Math.min(99, Math.round((fractionalDone / total) * 100));
    }
  }

  res.json({
    id: session.id,
    totalVideos: session.totalVideos,
    completed: session.completed,
    failed: session.failed,
    currentVideo: session.currentVideo,
    currentProgress,
    currentSpeed: session.currentSpeed || '',
    currentEta: session.currentEta || '',
    status: session.status,
    progress: overallProgress,
    files: session.files,
    errors: session.errors,
    downloadedTitles: session.downloadedTitles
  });
});

// API: Download ZIP file (level 0 = store only, instant bundling, zero CPU overhead!)
app.get('/api/download-zip/:sessionId', validateSessionId, (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session || session.status !== 'completed') {
    return res.status(400).json({ error: 'Download is not ready yet.' });
  }

  const sessionDir = path.join(DOWNLOADS_DIR, session.id);
  if (!fs.existsSync(sessionDir)) {
    return res.status(404).json({ error: 'Session directory not found.' });
  }

  const archive = archiver('zip', { zlib: { level: 0 } });
  const zipName = `playlist_${session.id.substring(0, 8)}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  archive.pipe(res);

  session.files.forEach(file => {
    const filePath = path.join(sessionDir, file);
    if (fs.existsSync(filePath)) {
      archive.file(filePath, { name: file });
    }
  });

  archive.finalize();

  archive.on('end', () => {
    setTimeout(() => {
      cleanupSession(session.id);
    }, 120000); // Clean up 2 minutes after download completes
  });
});

// API: Download single file
app.get('/api/download-file/:sessionId/:filename', validateSessionId, (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const sessionDir = path.join(DOWNLOADS_DIR, session.id);
  const safeFilename = path.basename(req.params.filename);
  const filePath = path.join(sessionDir, safeFilename);

  // Security: prevent directory traversal
  if (!path.resolve(filePath).startsWith(path.resolve(sessionDir))) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.download(filePath, safeFilename, () => {
    setTimeout(() => {
      cleanupSession(session.id);
    }, 120000);
  });
});

function cleanDownloadedFilename(filename) {
  const ext = path.extname(filename);
  let name = path.basename(filename, ext);

  name = name
    .replace(/\s*-\s*Topic\b/gi, '')
    .replace(/\s*VEVO\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  name = name.replace(/\s*-\s*(NA|Unknown)\b/gi, '').trim();

  const parts = name.split(' - ').map(p => p.trim()).filter(Boolean);
  if (parts.length >= 3) {
    const lastPart = parts[parts.length - 1].toLowerCase();
    if (lastPart.includes('music') || lastPart.includes('records') || lastPart.includes('entertainment') || lastPart.includes('official') || lastPart === 'unknown' || lastPart === 'na') {
      parts.pop();
      name = parts.join(' - ');
    }
  }

  let sanitized = name
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!sanitized) sanitized = 'Track';
  if (sanitized.length > 150) sanitized = sanitized.substring(0, 150).trim();

  return `${sanitized}${ext}`;
}

// Download videos with concurrency pool for maximum speed
async function downloadVideosConcurrently(session, videos, sessionDir, format, quality) {
  const concurrency = LIMITS.CONCURRENT_DOWNLOADS_PER_SESSION;
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < videos.length && session.status !== 'cancelled') {
      const index = currentIndex++;
      const video = videos[index];

      session.currentVideo = video.title || `Video ${index + 1}`;
      console.log(`[${index + 1}/${videos.length}] Starting download: ${session.currentVideo}`);

      try {
        await downloadSingleVideo(session, video, sessionDir, format, quality, session.ffmpegAvailable);
        
        if (session.status === 'cancelled') break;

        session.completed++;

        if (fs.existsSync(sessionDir)) {
          const files = fs.readdirSync(sessionDir);
          session.files = files;
          if (files.length > 0) {
            const latestFile = files[files.length - 1];
            const cleanTitle = path.basename(latestFile, path.extname(latestFile));
            if (!session.downloadedTitles.includes(cleanTitle)) {
              session.downloadedTitles.push(cleanTitle);
            }
          }
        }
        console.log(`  ✓ Success [${index + 1}/${videos.length}]`);
      } catch (err) {
        if (session.status === 'cancelled') break;
        session.failed++;
        session.errors.push({ video: video.title, error: err.message });
        console.error(`  ✗ Failed [${index + 1}/${videos.length}]: ${err.message.substring(0, 200)}`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, videos.length) }, () => worker());
  await Promise.all(workers);

  if (session.status !== 'cancelled') {
    session.status = 'completed';
    session.completedAt = Date.now();
    session.currentVideo = '';
    session.currentSpeed = '';
    session.currentEta = '';
    console.log(`\nDownload session complete: ${session.completed} success, ${session.failed} failed`);
  } else {
    console.log(`\nDownload session cancelled.`);
  }
}

function downloadSingleVideo(session, video, outputDir, format, quality, ffmpegAvailable) {
  return new Promise((resolve, reject) => {
    session.currentProgress = 0;

    let videoUrl = video.url;
    if (videoUrl && (videoUrl.startsWith('ytsearch1:') || videoUrl.startsWith('ytsearch:'))) {
      // Direct search query from Spotify/Metadata resolution
    } else if (!videoUrl || !videoUrl.startsWith('http')) {
      if (video.id && video.id.startsWith('http')) {
        videoUrl = video.id;
      } else if (video.id) {
        videoUrl = `https://www.youtube.com/watch?v=${video.id}`;
      } else {
        return reject(new Error('No valid video or media URL'));
      }
    }

    let filesBefore = new Set();
    if (fs.existsSync(outputDir)) {
      filesBefore = new Set(fs.readdirSync(outputDir));
    }

    const outputTemplate = path.join(outputDir, '%(title).100B - %(artist,uploader,channel)s.%(ext)s');

    let args = [
      '-o', outputTemplate,
      '--no-playlist',
      '--no-check-certificates',
      '--no-warnings',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      '--extractor-args', 'youtube:player_client=android'
    ];

    if (LIMITS.COOKIES_PATH && fs.existsSync(LIMITS.COOKIES_PATH)) {
      args.push('--cookies', LIMITS.COOKIES_PATH);
    }

    if (ffmpegAvailable) {
      if (ffmpegStatic) {
        args.push('--ffmpeg-location', ffmpegStatic);
      }
      args.push('--embed-thumbnail', '--add-metadata');
    }

    if (format === 'mp3') {
      if (ffmpegAvailable) {
        const audioQuality = quality === '320k' ? '0' :
                             quality === '256k' ? '2' :
                             quality === '192k' ? '4' :
                             quality === '128k' ? '5' : '0';

        args.push('-x', '--audio-format', 'mp3', '--audio-quality', audioQuality, '--prefer-free-formats');
      } else {
        args.push('-f', 'bestaudio/best');
      }
    } else if (format === 'mp4') {
      if (ffmpegAvailable) {
        const formatStr = quality === '1080p'
          ? 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080][ext=mp4]/best[height<=1080]/best'
          : quality === 'best'
            ? 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best'
            : quality === '720p'
              ? 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720][ext=mp4]/best[height<=720]/best'
              : 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480][ext=mp4]/best[height<=480]/best';
        args.push('-f', formatStr, '--merge-output-format', 'mp4');
      } else {
        args.push('-f', 'best[ext=mp4]/best');
      }
    }

    // Safety separator before positional argument
    args.push('--', videoUrl);

    const ytdlp = spawnYtDlp(args);
    if (!session.activeProcesses) session.activeProcesses = [];
    session.activeProcesses.push(ytdlp);

    let stdout = '';
    let stderr = '';

    ytdlp.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;

      if (chunk.includes('[download]') && chunk.includes('%')) {
        const matches = [...chunk.matchAll(/(\d+\.?\d*)%/g)];
        if (matches.length > 0) {
          const lastMatch = matches[matches.length - 1];
          const pct = parseFloat(lastMatch[1]);
          if (!isNaN(pct)) {
            session.currentProgress = pct;
          }
        }

        // Extract speed (e.g. at 5.24MiB/s)
        const speedMatch = chunk.match(/at\s+([\d\.]+\w+\/s)/);
        if (speedMatch) {
          session.currentSpeed = speedMatch[1];
        }

        // Extract ETA (e.g. ETA 00:05)
        const etaMatch = chunk.match(/ETA\s+([\d\:]+)/);
        if (etaMatch) {
          session.currentEta = etaMatch[1];
        }
      }
    });

    ytdlp.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ytdlp.on('close', (code) => {
      session.activeProcesses = session.activeProcesses.filter(p => p !== ytdlp);

      if (!fs.existsSync(outputDir)) {
        resolve();
        return;
      }

      const filesAfter = new Set(fs.readdirSync(outputDir));
      const newFiles = [...filesAfter].filter(f => !filesBefore.has(f) && !f.endsWith('.part') && !f.endsWith('.ytdl'));

      if (newFiles.length > 0) {
        session.currentProgress = 100;

        for (const downloadedFile of newFiles) {
          const cleanedName = cleanDownloadedFilename(downloadedFile);
          const currentPath = path.join(outputDir, downloadedFile);
          const targetPath = path.join(outputDir, cleanedName);

          if (currentPath !== targetPath) {
            try {
              if (fs.existsSync(targetPath)) {
                fs.unlinkSync(targetPath);
              }
              fs.renameSync(currentPath, targetPath);
            } catch (renameErr) {
              console.error(`  ⚠️ Could not rename file: ${renameErr.message}`);
            }
          }
        }

        resolve();
        return;
      }

      const allOutput = stdout + '\n' + stderr;

      if (allOutput.includes('has already been downloaded')) {
        resolve();
        return;
      }

      const errorLines = allOutput.split('\n').filter(line =>
        line.includes('ERROR') || line.includes('unable to download') ||
        line.includes('unavailable') || line.includes('Private video') ||
        line.includes('Sign in to confirm')
      );
      const isBotCheck = allOutput.includes('Sign in to confirm') || allOutput.includes('bot');
      const errorMsg = isBotCheck
        ? 'Dibatasi oleh YouTube (Sign in/Bot Check). Coba beberapa saat lagi.'
        : errorLines.length > 0
          ? errorLines[0].trim().replace(/^ERROR:\s*/, '')
          : `Download failed (exit code ${code}).`;

      reject(new Error(errorMsg));
    });

    ytdlp.on('error', (err) => {
      session.activeProcesses = session.activeProcesses.filter(p => p !== ytdlp);
      reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
    });
  });
}

function formatDuration(seconds) {
  if (!seconds) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) {
    return `${hrs}:${String(mins % 60).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function cleanupSession(sessionId) {
  const sessionDir = path.join(DOWNLOADS_DIR, sessionId);
  try {
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    sessions.delete(sessionId);
  } catch {}
}

// Periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    const age = now - (session.completedAt || session.createdAt || 0);
    if (session.status === 'completed' && age > LIMITS.SESSION_TTL_MS) {
      console.log(`  🧹 Auto-cleaning expired session: ${id.substring(0, 8)}`);
      cleanupSession(id);
    }
    if (session.status === 'downloading' && age > LIMITS.ORPHAN_TTL_MS) {
      console.log(`  🧹 Auto-cleaning stale session: ${id.substring(0, 8)}`);
      session.status = 'cancelled';
      if (session.activeProcesses) {
        session.activeProcesses.forEach(p => { try { p.kill('SIGTERM'); } catch {} });
      }
      cleanupSession(id);
    }
  }

  try {
    const folders = fs.readdirSync(DOWNLOADS_DIR);
    for (const folder of folders) {
      if (!sessions.has(folder)) {
        const folderPath = path.join(DOWNLOADS_DIR, folder);
        const stat = fs.statSync(folderPath);
        if (stat.isDirectory() && now - stat.mtimeMs > LIMITS.ORPHAN_TTL_MS) {
          console.log(`  🧹 Removing orphaned folder: ${folder.substring(0, 8)}`);
          fs.rmSync(folderPath, { recursive: true, force: true });
        }
      }
    }
  } catch {}
}, LIMITS.CLEANUP_INTERVAL_MS);

// Clean up leftover downloads on startup
try {
  const leftoverFolders = fs.readdirSync(DOWNLOADS_DIR);
  if (leftoverFolders.length > 0) {
    console.log(`  🧹 Cleaning ${leftoverFolders.length} leftover download(s) from previous run...`);
    leftoverFolders.forEach(folder => {
      fs.rmSync(path.join(DOWNLOADS_DIR, folder), { recursive: true, force: true });
    });
  }
} catch {}

// Graceful Shutdown
function handleShutdown(signal) {
  console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);
  for (const session of sessions.values()) {
    if (session.activeProcesses) {
      session.activeProcesses.forEach(p => { try { p.kill('SIGTERM'); } catch {} });
    }
  }
  process.exit(0);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

const HOST = process.env.HOST || '0.0.0.0';

// Ensure yt-dlp availability on launch
ensureYtDlpAvailable();

app.listen(PORT, HOST, () => {
  const ytdlpOk = checkYtDlp();
  const ffmpegOk = checkFfmpeg();
  console.log(`\n  🎵 PlaylistGet — Media Downloader`);
  console.log(`  ────────────────────────────────`);
  console.log(`  Server running at: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  yt-dlp status:  ${ytdlpOk ? '✅ Available' : '❌ Not found (Run: sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp)'}`);
  console.log(`  ffmpeg status:  ${ffmpegOk ? '✅ Available' : '⚠️  Not found'}`);
  console.log(`  Limits:  max ${LIMITS.MAX_PLAYLIST_SIZE} videos | ${LIMITS.MAX_CONCURRENT_SESSIONS} concurrent sessions | ${LIMITS.CONCURRENT_DOWNLOADS_PER_SESSION} parallel/session`);
  console.log('');
});
