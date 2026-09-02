require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');

const playlistHandler = require('./api/playlist');
const downloadHandler = require('./api/download');
const streamHandler = require('./api/stream');
const checkHandler = require('./api/check');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(cors());
app.use(express.json({ limit: '500kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Vercel Serverless API Handlers ──────────────────────────────────
app.all('/api/playlist', async (req, res) => {
  try {
    await playlistHandler(req, res);
  } catch (err) {
    console.error('Playlist route error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to process playlist: ' + err.message });
    }
  }
});

app.all('/api/download', async (req, res) => {
  try {
    await downloadHandler(req, res);
  } catch (err) {
    console.error('Download route error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to process download: ' + err.message });
    }
  }
});

app.all('/api/stream', async (req, res) => {
  try {
    await streamHandler(req, res);
  } catch (err) {
    console.error('Stream route error:', err);
    if (!res.headersSent) {
      res.status(500).send('Stream error: ' + err.message);
    }
  }
});

app.all('/api/check', (req, res) => {
  checkHandler(req, res);
});

// Fallback to single page app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  🎵 PlaylistGet — Vercel API Edition (Zero-Binary Mode)`);
  console.log(`  ─────────────────────────────────────────────────────`);
  console.log(`  Server running at: http://localhost:${PORT}`);
  console.log(`  Engine:     Cloud Media API (No yt-dlp / ffmpeg needed)\n`);
});
