# 🎵 PlaylistGet — Media Downloader

**PlaylistGet** is a self-hosted web application for batch downloading video and audio from **YouTube**, **YouTube Music**, and **Spotify**. Download entire playlists or single tracks as **MP3** or **MP4** with selectable quality — all from a sleek, modern web interface.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

---

## ✨ Features

| Feature | Description |
|---|---|
| 🎬 **YouTube Support** | Download single videos or entire playlists |
| 🎧 **YouTube Music** | Full compatibility with YouTube Music URLs |
| 🟢 **Spotify Integration** | Paste Spotify track, album, or playlist links — auto-searches YouTube for the best match |
| 🎚️ **Quality Selection** | MP3: 128k / 192k / 256k / 320kbps — MP4: 480p / 720p / 1080p / Best |
| 📦 **Smart Download** | Single files download directly; multiple files bundled as ZIP |
| 🧹 **Auto Cleanup** | Server-side temp files are cleaned up automatically after download |
| 🛡️ **Rate Limiting** | Built-in per-IP rate limiter prevents abuse |
| 📊 **Live Progress** | Real-time download progress with per-file status log |
| 🌙 **Premium Dark UI** | Beautiful glassmorphism dark theme with micro-animations |
| 📱 **Responsive** | Fully functional on desktop, tablet, and mobile |

---

## 📋 Prerequisites

- **[Node.js](https://nodejs.org/)** v18 or higher
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — Must be installed and available in your system PATH

### Install yt-dlp

```bash
# Using pip (recommended)
pip install yt-dlp

# Or on Windows via winget
winget install yt-dlp

# Or on macOS via Homebrew
brew install yt-dlp
```

> **Note:** `ffmpeg` is bundled automatically via `ffmpeg-static`. No manual ffmpeg installation needed.

---

## 🚀 Quick Start

```bash
# 1. Clone or download this project
git clone <your-repo-url>
cd youtube-playlist-downloader

# 2. Install dependencies
npm install

# 3. Start the server
npm start
```

Open your browser and go to **http://localhost:3000** 🎉

---

## 🔧 Usage

1. **Paste a URL** — YouTube video/playlist, YouTube Music, or Spotify track/playlist
2. **Select tracks** — Choose which items to download (all selected by default)
3. **Pick format & quality** — MP3 Audio or MP4 Video with your preferred quality
4. **Download** — Files are processed on the server and delivered as a direct download or ZIP

### Supported URL Formats

```
# YouTube
https://www.youtube.com/watch?v=VIDEO_ID
https://www.youtube.com/playlist?list=PLAYLIST_ID
https://music.youtube.com/watch?v=VIDEO_ID
https://music.youtube.com/playlist?list=PLAYLIST_ID

# Spotify
https://open.spotify.com/track/TRACK_ID
https://open.spotify.com/playlist/PLAYLIST_ID
https://open.spotify.com/album/ALBUM_ID
```

---

## 🛡️ Security & Resource Management

PlaylistGet includes multiple layers of protection to keep your server safe and efficient:

| Protection | Detail |
|---|---|
| **Rate Limiting** | 15 requests/minute per IP address |
| **Concurrent Sessions** | Max 3 active download sessions simultaneously |
| **Playlist Cap** | Max 50 videos per download batch |
| **Input Validation** | URL regex validation, length limits, format/quality whitelisting |
| **Request Size** | JSON body limited to 100KB |
| **Auto Cleanup** | Completed sessions expire after 30 minutes |
| **Orphan Detection** | Stale/stuck sessions force-cleaned after 60 minutes |
| **Startup Cleanup** | Leftover downloads from crashed runs are cleaned on boot |
| **Directory Traversal** | Path validation prevents accessing files outside session folders |

---

## 📁 Project Structure

```
youtube-playlist-downloader/
├── server.js           # Express backend — API, download logic, security
├── package.json        # Dependencies and scripts
├── README.md           # This file
├── public/             # Frontend static files
│   ├── index.html      # Main page (SEO-optimized)
│   ├── app.js          # Client-side application logic
│   └── style.css       # Premium dark theme styles
└── downloads/          # Temporary download folder (auto-cleaned)
```

---

## ⚙️ Configuration

All server limits are configurable in the `LIMITS` object at the top of `server.js`:

```js
const LIMITS = {
  MAX_PLAYLIST_SIZE: 50,          // Max videos per session
  MAX_CONCURRENT_SESSIONS: 3,     // Max parallel downloads
  SESSION_TTL_MS: 30 * 60 * 1000, // Session expiry (30 min)
  ORPHAN_TTL_MS: 60 * 60 * 1000,  // Stale session cleanup (60 min)
  RATE_LIMIT_MAX_REQUESTS: 15,    // Requests per minute per IP
  MAX_BODY_SIZE: '100kb',         // Request body size limit
};
```

---

## 🧰 Tech Stack

- **Backend:** Node.js, Express
- **Media:** [yt-dlp](https://github.com/yt-dlp/yt-dlp), [ffmpeg-static](https://www.npmjs.com/package/ffmpeg-static)
- **Bundling:** [archiver](https://www.npmjs.com/package/archiver) (ZIP)
- **Spotify:** [spotify-url-info](https://www.npmjs.com/package/spotify-url-info)
- **Frontend:** Vanilla HTML/CSS/JS with Inter & JetBrains Mono fonts

---

## ⚠️ Disclaimer

This tool is intended for **personal use only**. Please respect copyright laws and the terms of service of YouTube and Spotify. Only download content you have the right to access. The developers are not responsible for any misuse.

---

## 📄 License

MIT License — free for personal and educational use.
