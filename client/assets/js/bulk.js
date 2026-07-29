(function () {
  const TOKEN_KEY = 'pixelforge_token';
  const MAX_BATCH_FILES = 10;
  const MAX_FILE_BYTES = 15 * 1024 * 1024;
  const BATCH_POLL_INTERVAL_MS = 2500;

  const authGate = document.getElementById('auth-gate');
  const upgradeGate = document.getElementById('upgrade-gate');
  const uploadStage = document.getElementById('upload-stage');
  const toolSelect = document.getElementById('tool-select');
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');

  const reviewStage = document.getElementById('review-stage');
  const reviewGrid = document.getElementById('review-grid');
  const startProcessingBtn = document.getElementById('start-processing-btn');
  const addMoreBtn = document.getElementById('add-more-btn');
  const reviewCountLabel = document.getElementById('review-count-label');

  const batchStage = document.getElementById('batch-stage');
  const batchGrid = document.getElementById('batch-grid');
  const downloadZipBtn = document.getElementById('download-zip-btn');
  const startOverBtn = document.getElementById('start-over-btn');
  const batchStatusLabel = document.getElementById('batch-status-label');

  const errorBanner = document.getElementById('error-banner');

  let batchPollHandle = null;
  let currentJobs = []; // [{ jobId, filename, status, outputUrl }] — the active/completed batch
  let pendingFiles = []; // [{ file, previewSrc }] — files staged for review, before Start is clicked

  function showStage(stage) {
    [authGate, upgradeGate, uploadStage, reviewStage, batchStage].forEach((el) => el.classList.add('is-hidden'));
    stage.classList.remove('is-hidden');
  }
  function showError(msg) { errorBanner.textContent = msg; errorBanner.classList.remove('is-hidden'); }
  function clearError() { errorBanner.classList.add('is-hidden'); }
  function getToken() { return localStorage.getItem(TOKEN_KEY); }

  // Error messages can come from external APIs (Replicate, Dewatermark)
  // and shouldn't be trusted as safe HTML before being inserted into the
  // page — escape them the same way any other untrusted text would be.
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Checks the user's plan before even showing the upload UI — bulk
   * processing is Pro/Business only, so a free user should see a clear
   * upgrade prompt immediately rather than uploading files just to hit a
   * 403 afterward.
   */
  async function init() {
    const token = getToken();
    if (!token) {
      showStage(authGate);
      return;
    }

    try {
      const res = await fetch('/api/dashboard/me', { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        showStage(authGate);
        return;
      }
      const body = await res.json();
      if (body.success && body.user.plan_name === 'free') {
        showStage(upgradeGate);
        return;
      }
    } catch (err) {
      // If the plan check itself fails (network blip), fall through to
      // the upload UI anyway — the actual upload request enforces the
      // real gate server-side regardless, this check is just for a
      // smoother experience, not the actual security boundary.
    }

    showStage(uploadStage);
  }

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('is-dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-dragover');
    addFilesToPending([...e.dataTransfer.files]);
  });
  fileInput.addEventListener('change', (e) => {
    addFilesToPending([...e.target.files]);
    fileInput.value = ''; // reset so selecting the same file again still fires 'change'
  });

  addMoreBtn.addEventListener('click', () => fileInput.click());

  /**
   * Validates newly-selected files and appends them to the pending
   * review list (rather than starting the upload right away) — lets the
   * user build up a batch across multiple selections, remove any they
   * change their mind about, then explicitly confirm with Start.
   */
  function addFilesToPending(newFiles) {
    clearError();
    if (newFiles.length === 0) return;

    const combinedCount = pendingFiles.length + newFiles.length;
    if (combinedCount > MAX_BATCH_FILES) {
      showError(`You can have at most ${MAX_BATCH_FILES} images in a batch — you already have ${pendingFiles.length} and tried to add ${newFiles.length}.`);
      return;
    }

    const invalidType = newFiles.find((f) => !f.type.match(/^image\/(png|jpeg|webp)/));
    if (invalidType) {
      showError(`"${invalidType.name}" isn't a PNG, JPG, or WebP image.`);
      return;
    }
    const oversized = newFiles.find((f) => f.size > MAX_FILE_BYTES);
    if (oversized) {
      showError(`"${oversized.name}" is ${(oversized.size / 1024 / 1024).toFixed(1)}MB — the maximum is 15MB per image.`);
      return;
    }

    pendingFiles = pendingFiles.concat(
      newFiles.map((file) => ({ file, previewSrc: URL.createObjectURL(file) }))
    );
    renderReviewGrid();
    showStage(reviewStage);
  }

  function renderReviewGrid() {
    reviewGrid.innerHTML = pendingFiles.map((item, i) => `
      <div class="batch-item">
        <img class="batch-item-thumb" src="${item.previewSrc}" alt="${escapeHtml(item.file.name)}">
        <button class="image-remove-x" data-remove-index="${i}" title="Remove this image" aria-label="Remove image">✕</button>
        <div class="batch-item-info">
          <span class="batch-item-name">${escapeHtml(item.file.name)}</span>
        </div>
      </div>
    `).join('');

    reviewGrid.querySelectorAll('[data-remove-index]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const index = Number(btn.dataset.removeIndex);
        URL.revokeObjectURL(pendingFiles[index].previewSrc);
        pendingFiles.splice(index, 1);
        if (pendingFiles.length === 0) {
          showStage(uploadStage);
        } else {
          renderReviewGrid();
        }
      });
    });

    reviewCountLabel.textContent = `${pendingFiles.length} of ${MAX_BATCH_FILES} images`;
  }

  startProcessingBtn.addEventListener('click', () => {
    if (pendingFiles.length === 0) return;
    startBatch(pendingFiles.map((item) => item.file));
  });

  async function startBatch(files) {
    clearError();
    const token = getToken();
    if (!token) { showStage(authGate); return; }

    // Show the grid immediately with local previews before the network
    // call resolves, so the batch feels responsive even before any
    // server-side status is known yet.
    currentJobs = files.map((f) => ({
      jobId: null, filename: f.name, status: 'processing',
      outputUrl: null, previewSrc: URL.createObjectURL(f)
    }));
    renderBatchGrid();
    showStage(batchStage);
    downloadZipBtn.disabled = true;
    batchStatusLabel.textContent = 'Uploading…';

    try {
      const form = new FormData();
      form.append('tool', toolSelect.value);
      files.forEach((f) => form.append('images', f));

      const res = await fetch('/api/tools/bulk-upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form
      });

      const body = await res.json();

      if (res.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        showStage(authGate);
        showError('Your session expired. Please sign in again.');
        return;
      }
      if (res.status === 403) {
        showStage(upgradeGate);
        return;
      }
      if (!body.success) {
        showStage(reviewStage);
        showError(body.error || 'Something went wrong starting this batch.');
        return;
      }

      currentJobs = currentJobs.map((job, i) => ({ ...job, jobId: body.jobs[i].jobId }));
      batchStatusLabel.textContent = `Processing ${currentJobs.length} image${currentJobs.length > 1 ? 's' : ''}…`;
      startBatchPolling();
    } catch (err) {
      showStage(reviewStage);
      showError('Could not reach the server. Check your connection and try again.');
    }
  }

  function renderBatchGrid() {
    batchGrid.innerHTML = currentJobs.map((job, i) => {
      const statusClass = `batch-status-${job.status}`;
      const thumbSrc = job.status === 'completed' ? job.outputUrl : job.previewSrc;
      const errorHtml = (job.status === 'failed' && job.error)
        ? `<div class="batch-item-error" title="${escapeHtml(job.error)}">${escapeHtml(job.error)}</div>`
        : '';
      return `<div class="batch-item" data-index="${i}">
        <img class="batch-item-thumb" src="${thumbSrc || ''}" alt="${escapeHtml(job.filename)}">
        <div class="batch-item-info">
          <span class="batch-item-name">${escapeHtml(job.filename)}</span>
          <span class="batch-status-badge ${statusClass}" title="${job.status === 'failed' && job.error ? escapeHtml(job.error) : ''}">${job.status}</span>
        </div>
        ${errorHtml}
      </div>`;
    }).join('');
  }

  async function startBatchPolling() {
    async function tick() {
      const ids = currentJobs.map((j) => j.jobId).filter(Boolean).join(',');
      if (!ids) return;

      const token = getToken();
      try {
        const res = await fetch(`/api/jobs-batch?ids=${ids}`, { headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 401) {
          localStorage.removeItem(TOKEN_KEY);
          showStage(authGate);
          showError('Your session expired. Please sign in again — your batch is still processing and safe either way.');
          return;
        }
        const body = await res.json();
        if (!body.success) return;

        const byId = new Map(body.jobs.map((j) => [String(j.id), j]));
        currentJobs = currentJobs.map((job) => {
          const update = byId.get(String(job.jobId));
          if (!update) return job;
          return { ...job, status: update.status, outputUrl: update.outputUrl, error: update.error };
        });
        renderBatchGrid();

        const allDone = currentJobs.every((j) => j.status === 'completed' || j.status === 'failed');
        const completedCount = currentJobs.filter((j) => j.status === 'completed').length;
        const failedCount = currentJobs.filter((j) => j.status === 'failed').length;

        if (allDone) {
          batchStatusLabel.textContent = `${completedCount} done${failedCount ? `, ${failedCount} failed` : ''}`;
          downloadZipBtn.disabled = completedCount === 0;
          return; // stop polling
        }

        batchStatusLabel.textContent = `${completedCount + failedCount} of ${currentJobs.length} done…`;
        batchPollHandle = setTimeout(tick, BATCH_POLL_INTERVAL_MS);
      } catch (err) {
        // transient network issue — keep retrying, the batch is still
        // processing server-side regardless of whether we can reach it
        // right this second
        batchPollHandle = setTimeout(tick, BATCH_POLL_INTERVAL_MS);
      }
    }
    tick();
  }

  downloadZipBtn.addEventListener('click', async () => {
    const completedUrls = currentJobs.filter((j) => j.status === 'completed').map((j) => j.outputUrl);
    if (completedUrls.length === 0) return;

    const token = getToken();
    try {
      const res = await fetch('/api/download-zip', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: completedUrls })
      });
      if (!res.ok) {
        showError('Could not build the ZIP file. Try again.');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ai-vectorizer-Tools-batch.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      showError('Could not reach the server to build the ZIP. Try again.');
    }
  });

  startOverBtn.addEventListener('click', () => {
    if (batchPollHandle) clearTimeout(batchPollHandle);
    currentJobs = [];
    pendingFiles.forEach((item) => URL.revokeObjectURL(item.previewSrc));
    pendingFiles = [];
    fileInput.value = '';
    clearError();
    showStage(uploadStage);
  });

  init();
})();