const express = require('express');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');
const ffmpegStatic = require('ffmpeg-static');
const spotifyUrlInfo = require('spotify-url-info')(fetch);

const app = express();
const PORT = 3000;

// ── Security & Resource Limits ─────────────────────────────────────
const LIMITS = {
  MAX_PLAYLIST_SIZE: 200,        // Max videos per download session
  MAX_CONCURRENT_SESSIONS: 3,   // Max active download sessions at once
  SESSION_TTL_MS: 30 * 60 * 1000, // 30 min: auto-expire completed sessions
  ORPHAN_TTL_MS: 60 * 60 * 1000,  // 60 min: clean up orphaned folders
  CLEANUP_INTERVAL_MS: 5 * 60 * 1000, // Run cleanup every 5 minutes
  RATE_LIMIT_WINDOW_MS: 60 * 1000, // 1 minute window
  RATE_LIMIT_MAX_REQUESTS: 15,   // Max 15 requests per minute per IP
  MAX_BODY_SIZE: '100kb',        // Limit JSON body size
  ALLOWED_FORMATS: ['mp3', 'mp4'],
  ALLOWED_QUALITIES: ['128k', '192k', '256k', '320k', '480p', '720p', '1080p', 'best'],
};

// ── Simple rate limiter (per-IP, in-memory) ────────────────────────
const rateLimitStore = new Map();
function rateLimit(req, res, next) {
  // Only rate limit POST requests (fetching playlist and starting downloads)
  if (req.method !== 'POST') {
    return next();
  }
  const ip = req.ip || req.connection.remoteAddress;
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

// Middleware
app.use(express.json({ limit: LIMITS.MAX_BODY_SIZE }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(rateLimit);

// Store for download sessions
const sessions = new Map();

// Ensure downloads directory exists
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Check if yt-dlp is available
function checkYtDlp() {
  try {
    execSync('yt-dlp --version', { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
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

// API: Check system requirements
app.get('/api/check', (req, res) => {
  const ytDlpAvailable = checkYtDlp();
  const ffmpegAvailable = checkFfmpeg();
  let ytDlpVersion = null;
  if (ytDlpAvailable) {
    try {
      ytDlpVersion = execSync('yt-dlp --version', { encoding: 'utf-8', stdio: 'pipe' }).trim();
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

// API: Fetch playlist info
app.post('/api/playlist', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  const ytRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|music\.youtube\.com|youtu\.be)\/.+/;
  const spotifyRegex = /^(https?:\/\/)?(www\.)?open\.spotify\.com\/(playlist|track|album)\/.+/;

  if (!ytRegex.test(url) && !spotifyRegex.test(url)) {
    return res.status(400).json({ error: 'Invalid URL. Please provide a valid YouTube or Spotify URL.' });
  }

  // Reject URLs that are suspiciously long (possible injection attempt)
  if (url.length > 500) {
    return res.status(400).json({ error: 'URL is too long.' });
  }

  try {
    let args = [
      '--flat-playlist',
      '--dump-json',
      '--no-warnings',
      '--ignore-errors'
    ];

    let customTitle = null;

    if (spotifyRegex.test(url)) {
      // Fetch Spotify metadata
      const spotifyData = await spotifyUrlInfo.getData(url);
      
      if (spotifyData.type === 'track') {
        customTitle = `${spotifyData.name} - ${spotifyData.artists[0].name}`;
        args.push(`ytsearch1:${spotifyData.name} ${spotifyData.artists[0].name}`);
      } else if (spotifyData.trackList && spotifyData.trackList.length > 0) {
        customTitle = spotifyData.name;
        spotifyData.trackList.forEach(track => {
          args.push(`ytsearch1:${track.title} ${track.subtitle}`);
        });
      } else {
        return res.status(400).json({ error: 'Could not fetch tracks from Spotify URL.' });
      }
    } else {
      args.push(url);
    }

    const ytdlp = spawn('yt-dlp', args);
    let output = '';
    let errorOutput = '';

    ytdlp.stdout.on('data', (data) => {
      output += data.toString();
    });

    ytdlp.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    ytdlp.on('close', (code) => {
      if (!output.trim()) {
        return res.status(400).json({
          error: 'Could not fetch playlist. Make sure the URL is valid and public.',
          details: errorOutput
        });
      }

      try {
        const entries = output.trim().split('\n').map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        }).filter(Boolean);

        if (entries.length === 0) {
          return res.status(400).json({ error: 'No videos found.' });
        }

        // Extract title
        const playlistTitle = customTitle || entries[0].playlist_title || entries[0].playlist || entries[0].title || 'Unknown Playlist/Video';

        const videos = entries.map((entry, index) => ({
          id: entry.id || entry.url,
          title: entry.title || `Video ${index + 1}`,
          duration: entry.duration || null,
          durationString: entry.duration_string || formatDuration(entry.duration),
          thumbnail: entry.thumbnails?.[entry.thumbnails.length - 1]?.url
            || `https://img.youtube.com/vi/${entry.id}/mqdefault.jpg`,
          uploader: entry.uploader || entry.channel || 'Unknown',
          url: entry.url || entry.webpage_url || `https://www.youtube.com/watch?v=${entry.id}`,
          index: index + 1
        }));

        res.json({
          title: playlistTitle,
          count: videos.length,
          videos
        });
      } catch (parseError) {
        res.status(500).json({ error: 'Failed to parse data.', details: parseError.message });
      }
    });

    ytdlp.on('error', (err) => {
      res.status(500).json({ error: 'Failed to run yt-dlp.', details: err.message });
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// API: Cancel / Cleanup
app.post('/api/cancel/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (session) {
    session.status = 'cancelled';
    if (session.process) {
      try { session.process.kill(); } catch (e) {}
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
    return res.status(400).json({ error: `Maximum ${LIMITS.MAX_PLAYLIST_SIZE} videos per download. You selected ${videos.length}.` });
  }

  // Validate format & quality
  const format = LIMITS.ALLOWED_FORMATS.includes(req.body.format) ? req.body.format : 'mp3';
  const quality = LIMITS.ALLOWED_QUALITIES.includes(req.body.quality) ? req.body.quality : 'best';

  // Limit concurrent sessions
  const activeSessions = [...sessions.values()].filter(s => s.status === 'downloading').length;
  if (activeSessions >= LIMITS.MAX_CONCURRENT_SESSIONS) {
    return res.status(429).json({ error: 'Server is busy. Please wait for current downloads to finish and try again.' });
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
    status: 'downloading',
    progress: 0,
    files: [],
    errors: [],
    downloadedTitles: [],
    format,
    ffmpegAvailable,
    createdAt: Date.now(),
    completedAt: null
  };

  sessions.set(sessionId, session);

  // Start downloading in background
  downloadVideos(session, videos, sessionDir, format, quality);

  res.json({ sessionId, message: 'Download started' });
});

// API: Check download progress
app.get('/api/progress/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  const total = session.totalVideos || 0;
  const done = (session.completed || 0) + (session.failed || 0);
  res.json({
    ...session,
    progress: total > 0 ? Math.round((done / total) * 100) : 0
  });
});

// API: Download ZIP file
app.get('/api/download-zip/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session || session.status !== 'completed') {
    return res.status(400).json({ error: 'Download not ready yet.' });
  }

  const sessionDir = path.join(DOWNLOADS_DIR, session.id);

  // Create ZIP archive
  const archive = archiver('zip', { zlib: { level: 5 } });
  const zipName = `playlist_${session.id.substring(0, 8)}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  archive.pipe(res);

  // Add all downloaded files to the ZIP
  session.files.forEach(file => {
    const filePath = path.join(sessionDir, file);
    if (fs.existsSync(filePath)) {
      archive.file(filePath, { name: file });
    }
  });

  archive.finalize();

  // Clean up after a delay
  archive.on('end', () => {
    setTimeout(() => {
      cleanupSession(session.id);
    }, 120000); // Clean up 2 minutes after stream ends to ensure download completes
  });
});

// API: Download single file
app.get('/api/download-file/:sessionId/:filename', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const sessionDir = path.join(DOWNLOADS_DIR, session.id);
  const filePath = path.join(sessionDir, req.params.filename);

  // Security: prevent directory traversal
  if (!filePath.startsWith(sessionDir)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.download(filePath, (err) => {
    // Clean up after download finishes
    setTimeout(() => {
      cleanupSession(session.id);
    }, 120000); // 2 minutes to ensure browser finishes saving
  });
});

// Download videos sequentially
async function downloadVideos(session, videos, sessionDir, format, quality) {
  for (let i = 0; i < videos.length; i++) {
    if (session.status === 'cancelled') break;

    const video = videos[i];
    session.currentVideo = video.title || `Video ${i + 1}`;
    console.log(`[${i + 1}/${videos.length}] Downloading: ${session.currentVideo}`);

    try {
      await downloadSingleVideo(session, video, sessionDir, format, quality, session.ffmpegAvailable);
      
      if (session.status === 'cancelled') break;
      
      session.completed++;
      session.downloadedTitles.push(video.title);

      // Find the downloaded file
      const files = fs.readdirSync(sessionDir);
      session.files = files;
      console.log(`  ✓ Success`);
    } catch (err) {
      if (session.status === 'cancelled') {
        console.log(`  ⚠ Cancelled by user`);
        break;
      }
      session.failed++;
      session.errors.push({ video: video.title, error: err.message });
      console.error(`  ✗ Failed: ${err.message.substring(0, 200)}`);
    }
  }

  if (session.status !== 'cancelled') {
    session.status = 'completed';
    session.completedAt = Date.now();
    session.currentVideo = '';
    console.log(`\nDownload session complete: ${session.completed} success, ${session.failed} failed`);
  } else {
    console.log(`\nDownload session cancelled.`);
  }
}

function downloadSingleVideo(session, video, outputDir, format, quality, ffmpegAvailable) {
  return new Promise((resolve, reject) => {
    // Build the actual YouTube URL
    let videoUrl;
    if (video.url && video.url.startsWith('http')) {
      videoUrl = video.url;
    } else if (video.id) {
      videoUrl = `https://www.youtube.com/watch?v=${video.id}`;
    } else if (video.url) {
      videoUrl = `https://www.youtube.com/watch?v=${video.url}`;
    } else {
      return reject(new Error('No valid video URL or ID'));
    }

    // Count files before download to detect new files
    const filesBefore = new Set(fs.readdirSync(outputDir));

    // Sanitize output template — use a safe filename pattern
    const outputTemplate = path.join(outputDir, '%(title).100B.%(ext)s');

    let args = [
      '-o', outputTemplate,
      '--no-playlist',
      '--no-check-certificates',
      '--no-warnings'
    ];

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
          ? 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
          : quality === 'best'
            ? 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
            : quality === '720p'
              ? 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best'
              : 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best';
        args.push('-f', formatStr, '--merge-output-format', 'mp4');
      } else {
        args.push('-f', 'best[ext=mp4]/best');
      }
    }

    args.push(videoUrl);

    console.log(`  Command: yt-dlp ${args.join(' ')}`);

    const ytdlp = spawn('yt-dlp', args);
    session.process = ytdlp;

    let stdout = '';
    let stderr = '';

    ytdlp.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      // Log download progress
      if (chunk.includes('[download]') && chunk.includes('%')) {
        const match = chunk.match(/(\d+\.?\d*)%/);
        if (match) {
          process.stdout.write(`\r  Progress: ${match[1]}%`);
        }
      }
    });

    ytdlp.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ytdlp.on('close', (code) => {
      process.stdout.write('\n'); // Newline after progress

      // PRIMARY CHECK: Did any new files appear in the output directory?
      const filesAfter = new Set(fs.readdirSync(outputDir));
      const newFiles = [...filesAfter].filter(f => !filesBefore.has(f) && !f.endsWith('.part') && !f.endsWith('.ytdl'));

      if (newFiles.length > 0) {
        // File was downloaded successfully regardless of exit code
        console.log(`  📁 New file(s): ${newFiles.join(', ')}`);
        resolve();
        return;
      }

      // No new files — check if it was a real error
      const allOutput = stdout + '\n' + stderr;

      // Check for "already downloaded" case
      if (allOutput.includes('has already been downloaded')) {
        console.log(`  ℹ Already downloaded`);
        resolve();
        return;
      }

      // Actual failure
      const errorLines = allOutput.split('\n').filter(line =>
        line.includes('ERROR') || line.includes('unable to download') ||
        line.includes('unavailable') || line.includes('Private video') ||
        line.includes('Sign in to confirm')
      );
      const errorMsg = errorLines.length > 0
        ? errorLines[0].trim().replace(/^ERROR:\s*/, '')
        : `Download failed (exit code ${code}). ${stderr.substring(0, 200)}`;

      console.log(`  ❌ Error output: ${allOutput.substring(0, 300)}`);
      reject(new Error(errorMsg));
    });

    ytdlp.on('error', (err) => {
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

// ── Periodic cleanup: expired sessions + orphaned folders ─────────
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    const age = now - (session.completedAt || session.createdAt || 0);
    // Clean completed sessions older than TTL
    if (session.status === 'completed' && age > LIMITS.SESSION_TTL_MS) {
      console.log(`  🧹 Auto-cleaning expired session: ${id.substring(0, 8)}`);
      cleanupSession(id);
    }
    // Clean stuck/downloading sessions older than ORPHAN_TTL
    if (session.status === 'downloading' && age > LIMITS.ORPHAN_TTL_MS) {
      console.log(`  🧹 Auto-cleaning stale session: ${id.substring(0, 8)}`);
      session.status = 'cancelled';
      if (session.process) { try { session.process.kill(); } catch {} }
      cleanupSession(id);
    }
  }

  // Clean orphaned folders with no matching session
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

// ── Clean up leftover downloads from previous server runs ─────────
try {
  const leftoverFolders = fs.readdirSync(DOWNLOADS_DIR);
  if (leftoverFolders.length > 0) {
    console.log(`  🧹 Cleaning ${leftoverFolders.length} leftover download(s) from previous run...`);
    leftoverFolders.forEach(folder => {
      fs.rmSync(path.join(DOWNLOADS_DIR, folder), { recursive: true, force: true });
    });
  }
} catch {}

app.listen(PORT, () => {
  const ffmpegOk = checkFfmpeg();
  console.log(`\n  🎵 PlaylistGet — Media Downloader`);
  console.log(`  ────────────────────────────────`);
  console.log(`  Server running at: http://localhost:${PORT}`);
  console.log(`  yt-dlp status:  ${checkYtDlp() ? '✅ Available' : '❌ Not found'}`);
  console.log(`  ffmpeg status:  ${ffmpegOk ? '✅ Available' : '⚠️  Not found (MP3 conversion disabled)'}`);
  console.log(`  Limits:  max ${LIMITS.MAX_PLAYLIST_SIZE} videos | ${LIMITS.MAX_CONCURRENT_SESSIONS} concurrent sessions`);
  if (!ffmpegOk) {
    console.log(`\n  💡 To enable MP3 conversion, install ffmpeg:`);
    console.log(`     Download from: https://ffmpeg.org/download.html`);
    console.log(`     Or: winget install Gyan.FFmpeg`);
  }
  console.log('');
});
