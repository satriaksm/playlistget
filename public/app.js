// ============================================
// PlaylistGet — Frontend Application Logic
// ============================================

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const els = {
    systemStatus: document.getElementById('systemStatus'),
    playlistUrl: document.getElementById('playlistUrl'),
    pasteBtn: document.getElementById('pasteBtn'),
    fetchBtn: document.getElementById('fetchBtn'),
    inputSection: document.getElementById('inputSection'),
    loadingSection: document.getElementById('loadingSection'),
    errorSection: document.getElementById('errorSection'),
    errorText: document.getElementById('errorText'),
    retryBtn: document.getElementById('retryBtn'),
    resultsSection: document.getElementById('resultsSection'),
    playlistTitle: document.getElementById('playlistTitle'),
    videoCount: document.getElementById('videoCount'),
    selectedCount: document.getElementById('selectedCount'),
    selectAllBtn: document.getElementById('selectAllBtn'),
    deselectAllBtn: document.getElementById('deselectAllBtn'),
    videoList: document.getElementById('videoList'),
    formatMp3: document.getElementById('formatMp3'),
    formatMp4: document.getElementById('formatMp4'),
    qualityGroup: document.getElementById('qualityGroup'),
    qualitySelect: document.getElementById('qualitySelect'),
    downloadBtn: document.getElementById('downloadBtn'),
    downloadCount: document.getElementById('downloadCount'),
    downloadPanel: document.getElementById('downloadPanel'),
    progressSection: document.getElementById('progressSection'),
    progressBar: document.getElementById('progressBar'),
    progressPercent: document.getElementById('progressPercent'),
    progressCount: document.getElementById('progressCount'),
    currentDownload: document.getElementById('currentDownload'),
    progressLog: document.getElementById('progressLog'),
    completeSection: document.getElementById('completeSection'),
    completeStats: document.getElementById('completeStats'),
    completeErrors: document.getElementById('completeErrors'),
    errorSummary: document.getElementById('errorSummary'),
    downloadZipBtn: document.getElementById('downloadZipBtn'),
    newDownloadBtn: document.getElementById('newDownloadBtn'),
  };

  // State
  let state = {
    videos: [],
    selectedIds: new Set(),
    format: 'mp3',
    quality: 'best',
    sessionId: null,
    pollingInterval: null,
    isDownloading: false,
  };

  // ---- Initialize ----
  checkSystem();
  setupEventListeners();

  // ---- System Check ----
  async function checkSystem() {
    try {
      const res = await fetch('/api/check');
      const data = await res.json();
      state.ffmpegAvailable = data.ffmpegAvailable;

      const dot = els.systemStatus.querySelector('.status-dot');
      const text = els.systemStatus.querySelector('span');

      if (data.ytDlpAvailable) {
        dot.classList.add('ready');
        text.textContent = `yt-dlp v${data.ytDlpVersion}`;
      } else {
        dot.classList.add('error');
        text.textContent = 'yt-dlp not found';
        showError('yt-dlp is not installed. Please install it from https://github.com/yt-dlp/yt-dlp#installation');
      }

      // Show ffmpeg warning
      if (data.ytDlpAvailable && !data.ffmpegAvailable) {
        const warning = document.createElement('div');
        warning.className = 'ffmpeg-warning';
        warning.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <span><strong>ffmpeg not found.</strong> Audio will be downloaded as .webm/.m4a (no MP3 conversion). 
          Install ffmpeg: <code>winget install Gyan.FFmpeg</code> or download from <a href="https://ffmpeg.org/download.html" target="_blank">ffmpeg.org</a></span>
        `;
        els.inputSection.insertBefore(warning, els.inputSection.querySelector('.input-group'));
      }
    } catch {
      const dot = els.systemStatus.querySelector('.status-dot');
      const text = els.systemStatus.querySelector('span');
      dot.classList.add('error');
      text.textContent = 'Connection error';
    }
  }

  // ---- Event Listeners ----
  function setupEventListeners() {
    // Paste button
    els.pasteBtn.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        els.playlistUrl.value = text;
        els.playlistUrl.focus();
      } catch {
        // Fallback: focus input for manual paste
        els.playlistUrl.focus();
      }
    });

    // Fetch button
    els.fetchBtn.addEventListener('click', fetchPlaylist);

    // Enter key on input
    els.playlistUrl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') fetchPlaylist();
    });

    // Retry button
    els.retryBtn.addEventListener('click', () => {
      hideSection(els.errorSection);
      showSection(els.inputSection);
    });

    // Select all / deselect all
    els.selectAllBtn.addEventListener('click', () => {
      state.selectedIds = new Set(state.videos.map(v => v.id));
      updateVideoSelection();
    });

    els.deselectAllBtn.addEventListener('click', () => {
      state.selectedIds.clear();
      updateVideoSelection();
    });

    // Format buttons
    els.formatMp3.addEventListener('click', () => setFormat('mp3'));
    els.formatMp4.addEventListener('click', () => setFormat('mp4'));

    // Quality select
    els.qualitySelect.addEventListener('change', (e) => {
      state.quality = e.target.value;
    });

    // Download button
    els.downloadBtn.addEventListener('click', startDownload);

    // Download ZIP
    els.downloadZipBtn.addEventListener('click', downloadZip);

    // New download
    els.newDownloadBtn.addEventListener('click', resetApp);

    // Initialize format UI
    setFormat('mp3');

    // Handle interrupt / page unload
    window.addEventListener('beforeunload', () => {
      if (state.sessionId && !state.isDownloading) {
        navigator.sendBeacon(`/api/cancel/${state.sessionId}`);
      }
    });
  }

  // ---- Fetch Playlist ----
  async function fetchPlaylist() {
    const url = els.playlistUrl.value.trim();
    if (!url) {
      els.playlistUrl.focus();
      shakeElement(els.playlistUrl);
      return;
    }

    if (state.sessionId) {
      navigator.sendBeacon(`/api/cancel/${state.sessionId}`);
      state.sessionId = null;
    }

    hideSection(els.errorSection);
    hideSection(els.resultsSection);
    hideSection(els.completeSection);
    showSection(els.loadingSection);

    try {
      const res = await fetch('/api/playlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to fetch playlist');
      }

      state.videos = data.videos;
      state.selectedIds = new Set(data.videos.map(v => v.id));

      renderPlaylist(data);
      hideSection(els.loadingSection);
      showSection(els.resultsSection);
    } catch (err) {
      hideSection(els.loadingSection);
      showError(err.message);
    }
  }

  // ---- Render Playlist ----
  function renderPlaylist(data) {
    els.playlistTitle.textContent = data.title;
    els.videoCount.textContent = data.count;
    els.videoList.innerHTML = '';

    data.videos.forEach(video => {
      const item = document.createElement('div');
      item.className = 'video-item selected';
      item.dataset.id = video.id;
      item.innerHTML = `
        <div class="video-checkbox">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <span class="video-index">${video.index}</span>
        <img class="video-thumb" src="${video.thumbnail}" alt="" loading="lazy"
             onerror="this.style.display='none'" />
        <div class="video-info">
          <div class="video-title" title="${escapeHtml(video.title)}">${escapeHtml(video.title)}</div>
          <div class="video-meta">
            <span>${escapeHtml(video.uploader)}</span>
          </div>
        </div>
        <span class="video-duration">${video.durationString || ''}</span>
      `;

      item.addEventListener('click', () => toggleVideo(video.id, item));
      els.videoList.appendChild(item);
    });

    updateSelectionCounts();
  }

  // ---- Toggle Video Selection ----
  function toggleVideo(id, element) {
    if (state.selectedIds.has(id)) {
      state.selectedIds.delete(id);
      element.classList.remove('selected');
    } else {
      state.selectedIds.add(id);
      element.classList.add('selected');
    }
    updateSelectionCounts();
  }

  function updateVideoSelection() {
    const items = els.videoList.querySelectorAll('.video-item');
    items.forEach(item => {
      const id = item.dataset.id;
      if (state.selectedIds.has(id)) {
        item.classList.add('selected');
      } else {
        item.classList.remove('selected');
      }
    });
    updateSelectionCounts();
  }

  function updateSelectionCounts() {
    const count = state.selectedIds.size;
    els.selectedCount.textContent = count;
    els.downloadCount.textContent = count;
    els.downloadBtn.disabled = count === 0;
  }

  // ---- Format ----
  function setFormat(format) {
    state.format = format;
    els.formatMp3.classList.toggle('active', format === 'mp3');
    els.formatMp4.classList.toggle('active', format === 'mp4');
    
    els.qualityGroup.classList.remove('hidden');
    els.qualitySelect.innerHTML = '';
    
    if (format === 'mp3') {
      const options = [
        { value: '320k', text: 'Best (320kbps)' },
        { value: '256k', text: 'High (256kbps)' },
        { value: '192k', text: 'Medium (192kbps)' },
        { value: '128k', text: 'Low (128kbps)' }
      ];
      options.forEach(opt => {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.text;
        els.qualitySelect.appendChild(o);
      });
      state.quality = '320k';
    } else {
      const options = [
        { value: '1080p', text: '1080p (FHD)' },
        { value: 'best', text: 'Best Video Quality' },
        { value: '720p', text: '720p (HD)' },
        { value: '480p', text: '480p (SD)' }
      ];
      options.forEach(opt => {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.text;
        if (opt.value === 'best') o.selected = true;
        els.qualitySelect.appendChild(o);
      });
      state.quality = 'best';
    }
  }

  // ---- Start Download ----
  async function startDownload() {
    const selectedVideos = state.videos.filter(v => state.selectedIds.has(v.id));
    if (selectedVideos.length === 0) return;

    hideSection(els.resultsSection);
    showSection(els.progressSection);

    els.progressBar.style.width = '0%';
    els.progressPercent.textContent = '0%';
    els.progressCount.textContent = `0 / ${selectedVideos.length}`;
    els.currentDownload.textContent = 'Starting download...';
    els.progressLog.innerHTML = '';

    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videos: selectedVideos,
          format: state.format,
          quality: state.quality,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      state.sessionId = data.sessionId;
      startPolling();
    } catch (err) {
      hideSection(els.progressSection);
      showError(err.message);
    }
  }

  // ---- Progress Polling ----
  function startPolling() {
    if (state.pollingInterval) clearInterval(state.pollingInterval);

    state.pollingInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/progress/${state.sessionId}`);
        const data = await res.json();

        if (data.error) return;

        updateProgress(data);

        if (data.status === 'completed') {
          clearInterval(state.pollingInterval);
          state.pollingInterval = null;
          showComplete(data);
        }
      } catch {
        // Ignore polling errors
      }
    }, 1500);
  }

  function updateProgress(data) {
    const total = data.totalVideos || 0;
    const done = (data.completed || 0) + (data.failed || 0);
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;

    els.progressBar.style.width = `${percent}%`;
    els.progressPercent.textContent = `${percent}%`;
    els.progressCount.textContent = `${done} / ${total}`;
    els.currentDownload.textContent = data.currentVideo
      ? `Processing: ${data.currentVideo}`
      : 'Processing...';

    // Update log
    updateLog(data);
  }

  function updateLog(data) {
    const existingEntries = els.progressLog.querySelectorAll('.log-entry').length;
    const completed = data.completed;
    const failed = data.failed;
    const total = completed + failed;

    // Only add new entries
    if (total > existingEntries) {
      // Check errors
      if (data.errors.length > existingEntries - (completed > 0 ? completed - data.errors.length : 0)) {
        const latestErrors = data.errors.slice(existingEntries > completed ? existingEntries - completed : 0);
        latestErrors.forEach(err => {
          addLogEntry(`✗ Failed: ${err.video}`, 'error');
        });
      }

      // We'll just update the count display
      if (completed > 0) {
        const successCount = els.progressLog.querySelectorAll('.log-success').length;
        if (successCount < completed) {
          for (let i = successCount; i < completed; i++) {
            const title = (data.downloadedTitles && data.downloadedTitles[i]) || 'Unknown';
            addLogEntry(`✓ ${title} — Processed successfully`, 'success');
          }
        }
      }
    }
  }

  function addLogEntry(text, type) {
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    entry.textContent = text;
    els.progressLog.appendChild(entry);
    els.progressLog.scrollTop = els.progressLog.scrollHeight;
  }

  // ---- Show Complete ----
  function showComplete(data) {
    state.downloadData = data;
    hideSection(els.progressSection);
    showSection(els.completeSection);

    els.completeStats.innerHTML = `<strong>${data.completed} file(s) processed successfully</strong>`;
    if (data.downloadedTitles && data.downloadedTitles.length > 0) {
      els.completeStats.innerHTML += `<div style="margin-top: 15px; text-align: left; background: rgba(0,0,0,0.2); padding: 12px; border-radius: 8px; font-size: 0.85rem; color: var(--text-secondary); max-height: 180px; overflow-y: auto; border: 1px solid rgba(255,255,255,0.05);">
        <ul style="margin: 0; padding-left: 20px;">
          ${data.downloadedTitles.map(t => `<li style="margin-bottom: 4px;">${escapeHtml(t)}</li>`).join('')}
        </ul>
      </div>`;
    }

    if (data.failed > 0) {
      els.completeErrors.classList.remove('hidden');
      els.errorSummary.textContent = `${data.failed} file(s) failed to process`;
    } else {
      els.completeErrors.classList.add('hidden');
    }

    if (data.completed === 1 && data.files && data.files.length === 1) {
      els.downloadZipBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        Download File
      `;
    } else {
      els.downloadZipBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        Download ZIP
      `;
    }
  }

  // ---- Download ZIP or File ----
  function downloadZip() {
    if (state.sessionId && state.downloadData) {
      state.isDownloading = true;
      const data = state.downloadData;
      let url;
      if (data.completed === 1 && data.files && data.files.length === 1) {
        url = `/api/download-file/${state.sessionId}/${encodeURIComponent(data.files[0])}`;
      } else {
        url = `/api/download-zip/${state.sessionId}`;
      }

      // Use invisible <a> to trigger download without page navigation
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      // Reset after giving the download enough time to start
      setTimeout(() => {
        state.isDownloading = false;
        resetApp();
      }, 3000);
    }
  }

  // ---- Reset ----
  function resetApp() {
    state.videos = [];
    state.selectedIds.clear();
    state.sessionId = null;
    if (state.pollingInterval) clearInterval(state.pollingInterval);

    els.playlistUrl.value = '';
    els.videoList.innerHTML = '';

    hideSection(els.loadingSection);
    hideSection(els.errorSection);
    hideSection(els.resultsSection);
    hideSection(els.progressSection);
    hideSection(els.completeSection);
    showSection(els.inputSection);
  }

  // ---- Helpers ----
  function showSection(el) {
    el.classList.remove('hidden');
  }

  function hideSection(el) {
    el.classList.add('hidden');
  }

  function showError(message) {
    els.errorText.textContent = message;
    showSection(els.errorSection);
  }

  function shakeElement(el) {
    el.style.animation = 'none';
    el.offsetHeight; // Trigger reflow
    el.style.animation = 'shake 0.5s ease';
    setTimeout(() => { el.style.animation = ''; }, 500);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
});

// Add shake animation
const style = document.createElement('style');
style.textContent = `
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    20% { transform: translateX(-8px); }
    40% { transform: translateX(8px); }
    60% { transform: translateX(-4px); }
    80% { transform: translateX(4px); }
  }
`;
document.head.appendChild(style);
