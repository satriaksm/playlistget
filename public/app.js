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
    playlistSearchInput: document.getElementById('playlistSearchInput'),
    clearSearchBtn: document.getElementById('clearSearchBtn'),
    searchCountBadge: document.getElementById('searchCountBadge'),
    progressSpeed: document.getElementById('progressSpeed'),
    progressEta: document.getElementById('progressEta'),
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
    searchQuery: '',
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

    // Search filter input
    if (els.playlistSearchInput) {
      els.playlistSearchInput.addEventListener('input', (e) => {
        state.searchQuery = e.target.value.toLowerCase().trim();
        filterVideoList();
      });
    }

    // Clear search filter
    if (els.clearSearchBtn) {
      els.clearSearchBtn.addEventListener('click', () => {
        els.playlistSearchInput.value = '';
        state.searchQuery = '';
        filterVideoList();
        els.playlistSearchInput.focus();
      });
    }

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

    // Example tags click to auto-fill
    document.querySelectorAll('.example-tag').forEach(tag => {
      tag.addEventListener('click', () => {
        const url = tag.dataset.url;
        if (url) {
          els.playlistUrl.value = url;
          els.playlistUrl.focus();
          els.playlistUrl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    });

    // FAQ Accordion
    document.querySelectorAll('.faq-item').forEach(item => {
      const questionBtn = item.querySelector('.faq-question');
      if (questionBtn) {
        questionBtn.addEventListener('click', () => {
          const isActive = item.classList.contains('active');
          document.querySelectorAll('.faq-item').forEach(other => {
            if (other !== item) {
              other.classList.remove('active');
              const btn = other.querySelector('.faq-question');
              if (btn) btn.setAttribute('aria-expanded', 'false');
            }
          });
          item.classList.toggle('active', !isActive);
          questionBtn.setAttribute('aria-expanded', String(!isActive));
        });
      }
    });

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

    if (els.playlistSearchInput) els.playlistSearchInput.value = '';
    state.searchQuery = '';
    if (els.clearSearchBtn) els.clearSearchBtn.classList.add('hidden');
    if (els.searchCountBadge) els.searchCountBadge.textContent = `Showing all ${data.count} tracks`;

    data.videos.forEach(video => {
      const item = document.createElement('div');
      item.className = 'video-item selected';
      item.dataset.id = video.id;
      item.dataset.title = (video.title || '').toLowerCase();
      item.dataset.uploader = (video.uploader || '').toLowerCase();
      
      const pType = video.platformType || 'generic';
      const pName = video.platform || 'Media';
      const platformTagHtml = `<span class="track-platform-tag ${pType}">${escapeHtml(pName)}</span>`;

      const thumbHtml = video.thumbnail
        ? `<img class="video-thumb" src="${escapeHtml(video.thumbnail)}" alt="" loading="lazy" onerror="this.onerror=null; this.parentElement.querySelector('.video-thumb-fallback')?.classList.remove('hidden'); this.remove();" />
           <div class="video-thumb-fallback hidden"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`
        : `<div class="video-thumb-fallback"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`;

      item.innerHTML = `
        <div class="video-checkbox">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <span class="video-index">${video.index}</span>
        ${thumbHtml}
        <div class="video-info">
          <div class="video-title" title="${escapeHtml(video.title)}">${escapeHtml(video.title)}</div>
          <div class="video-meta">
            ${platformTagHtml}
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

  // ---- Filter Video List in Real-Time ----
  function filterVideoList() {
    const query = state.searchQuery;
    const items = els.videoList.querySelectorAll('.video-item');
    let visibleCount = 0;

    items.forEach(item => {
      const title = item.dataset.title || '';
      const uploader = item.dataset.uploader || '';
      const matches = !query || title.includes(query) || uploader.includes(query);

      if (matches) {
        item.style.display = 'flex';
        visibleCount++;
      } else {
        item.style.display = 'none';
      }
    });

    if (els.clearSearchBtn) {
      els.clearSearchBtn.classList.toggle('hidden', !query);
    }

    if (els.searchCountBadge) {
      if (query) {
        els.searchCountBadge.textContent = `Showing ${visibleCount} of ${state.videos.length} tracks`;
      } else {
        els.searchCountBadge.textContent = `Showing all ${state.videos.length} tracks`;
      }
    }
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
        { value: '320k', text: '320 kbps (Studio Quality)' },
        { value: '256k', text: '256 kbps (High Quality)' },
        { value: '192k', text: '192 kbps (Standard Quality)' },
        { value: '128k', text: '128 kbps (Compact Size)' }
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
        { value: '1080p', text: '1080p (Full HD)' },
        { value: 'best', text: 'Best Available Resolution' },
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

  // ---- Start Download (Vercel Serverless + JSZip Edition) ----
  async function startDownload() {
    const selectedVideos = state.videos.filter(v => state.selectedIds.has(v.id));
    if (selectedVideos.length === 0) return;

    hideSection(els.resultsSection);
    showSection(els.progressSection);

    els.progressBar.style.width = '0%';
    els.progressPercent.textContent = '0%';
    els.progressCount.textContent = `0 / ${selectedVideos.length}`;
    if (els.progressSpeed) els.progressSpeed.textContent = '-- MB/s';
    if (els.progressEta) els.progressEta.textContent = '--:--';
    els.currentDownload.textContent = 'Preparing download session...';
    els.progressLog.innerHTML = '';

    const downloadedTitles = [];
    const errors = [];
    const files = [];

    // Case 1: Single file download
    if (selectedVideos.length === 1) {
      const video = selectedVideos[0];
      els.currentDownload.textContent = `Resolving: ${video.title}`;
      els.progressBar.style.width = '50%';
      els.progressPercent.textContent = '50%';

      try {
        const res = await fetch('/api/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: video.url,
            format: state.format,
            quality: state.quality,
            title: video.title,
            playUrl: video.playUrl,
            musicUrl: video.musicUrl
          })
        });

        const data = await res.json();
        if (!res.ok || !data.downloadUrl) {
          throw new Error(data.error || 'Failed to prepare download link');
        }

        els.progressBar.style.width = '100%';
        els.progressPercent.textContent = '100%';
        els.progressCount.textContent = `1 / 1`;
        addLogEntry(`✓ ${video.title} — Ready for download`, 'success');

        downloadedTitles.push(video.title);
        const filename = data.filename || `${video.title}.${state.format}`;
        files.push(filename);

        state.directDownloadUrl = data.downloadUrl;
        state.directFilename = filename;

        // Auto trigger direct browser download
        const a = document.createElement('a');
        a.href = data.downloadUrl;
        a.download = filename;
        a.target = '_blank';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => a.remove(), 1000);

        showComplete({
          completed: 1,
          failed: 0,
          totalVideos: 1,
          downloadedTitles,
          files,
          downloadUrl: data.downloadUrl,
          filename
        });

      } catch (err) {
        hideSection(els.progressSection);
        showError(err.message);
      }
      return;
    }

    // Case 2: Batch / Multiple Files (In-Browser JSZip Engine)
    const zip = typeof JSZip !== 'undefined' ? new JSZip() : null;
    let completedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < selectedVideos.length; i++) {
      const video = selectedVideos[i];
      const percent = Math.round((i / selectedVideos.length) * 100);
      els.progressBar.style.width = `${percent}%`;
      els.progressPercent.textContent = `${percent}%`;
      els.progressCount.textContent = `${i} / ${selectedVideos.length}`;
      els.currentDownload.textContent = `[${i + 1}/${selectedVideos.length}] Downloading: ${video.title}`;

      try {
        const res = await fetch('/api/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: video.url,
            format: state.format,
            quality: state.quality,
            title: video.title,
            playUrl: video.playUrl,
            musicUrl: video.musicUrl
          })
        });

        const data = await res.json();
        if (res.ok && data.downloadUrl) {
          // Fetch media stream blob for ZIP packaging
          const mediaRes = await fetch(data.downloadUrl);
          if (mediaRes.ok) {
            const blob = await mediaRes.blob();
            const filename = data.filename || `${video.title}.${state.format}`;
            if (zip) {
              zip.file(filename, blob);
            }
            completedCount++;
            downloadedTitles.push(video.title);
            files.push(filename);
            addLogEntry(`✓ [${i + 1}/${selectedVideos.length}] ${video.title} — Added to ZIP`, 'success');
          } else {
            throw new Error('Could not stream media');
          }
        } else {
          throw new Error(data.error || 'Failed to resolve download link');
        }
      } catch (err) {
        failedCount++;
        errors.push({ video: video.title, error: err.message });
        addLogEntry(`✗ [${i + 1}/${selectedVideos.length}] ${video.title} — ${err.message}`, 'error');
      }
    }

    els.progressBar.style.width = '100%';
    els.progressPercent.textContent = '100%';
    els.progressCount.textContent = `${completedCount} / ${selectedVideos.length}`;

    if (zip && completedCount > 0) {
      els.currentDownload.textContent = 'Generating ZIP archive in browser...';
      try {
        const zipBlob = await zip.generateAsync({ type: 'blob' }, (metadata) => {
          els.currentDownload.textContent = `Compressing ZIP: ${Math.round(metadata.percent)}%`;
        });

        state.generatedZipBlob = zipBlob;
        state.generatedZipFilename = `playlist_${Date.now()}.zip`;

        if (typeof saveAs !== 'undefined') {
          saveAs(zipBlob, state.generatedZipFilename);
        }

        showComplete({
          completed: completedCount,
          failed: failedCount,
          totalVideos: selectedVideos.length,
          downloadedTitles,
          files,
          isClientZip: true
        });
      } catch (zipErr) {
        showError('Failed to generate ZIP archive: ' + zipErr.message);
      }
    } else {
      showComplete({
        completed: completedCount,
        failed: failedCount,
        totalVideos: selectedVideos.length,
        downloadedTitles,
        files
      });
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

    if (data.completed === 1) {
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
    if (state.generatedZipBlob) {
      if (typeof saveAs !== 'undefined') {
        saveAs(state.generatedZipBlob, state.generatedZipFilename || 'playlist.zip');
      }
      return;
    }

    if (state.directDownloadUrl) {
      const a = document.createElement('a');
      a.href = state.directDownloadUrl;
      a.download = state.directFilename || 'download.mp3';
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 1000);
      return;
    }
  }

  // ---- Reset ----
  function resetApp() {
    state.videos = [];
    state.selectedIds.clear();
    state.sessionId = null;
    state.searchQuery = '';
    if (state.pollingInterval) clearInterval(state.pollingInterval);

    els.playlistUrl.value = '';
    els.videoList.innerHTML = '';
    if (els.playlistSearchInput) els.playlistSearchInput.value = '';
    if (els.clearSearchBtn) els.clearSearchBtn.classList.add('hidden');
    if (els.progressSpeed) els.progressSpeed.textContent = '-- MB/s';
    if (els.progressEta) els.progressEta.textContent = '--:--';

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
