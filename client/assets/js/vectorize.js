(function () {
  const TOKEN_KEY = 'pixelforge_token';
  const TOOL_NAME = 'vectorize';

  const authGate = document.getElementById('auth-gate');

  const uploadStage = document.getElementById('upload-stage');
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');

  const convertingStage = document.getElementById('converting-stage');
  const convertingFilename = document.getElementById('converting-filename');
  const cancelBtn = document.getElementById('cancel-btn');

  const resultStage = document.getElementById('result-stage');
  const resultPreview = document.getElementById('result-preview');
  const resultFilename = document.getElementById('result-filename');
  const resultShapes = document.getElementById('result-shapes');
  const downloadBtn = document.getElementById('download-btn');
  const startOverBtn = document.getElementById('start-over-btn');

  const errorBanner = document.getElementById('error-banner');

  const MAX_FILE_BYTES = 30 * 1024 * 1024;

  function showStage(stage) {
    [authGate, uploadStage, convertingStage, resultStage].forEach((el) => el.classList.add('is-hidden'));
    stage.classList.remove('is-hidden');
  }
  function showError(msg) { errorBanner.textContent = msg; errorBanner.classList.remove('is-hidden'); }
  function clearError() { errorBanner.classList.add('is-hidden'); }
  function getToken() { return localStorage.getItem(TOKEN_KEY); }

  function init() {
    if (!getToken()) { showStage(authGate); return; }

    // Resume an in-progress job if the page was refreshed mid-processing.
    const savedJobId = window.PixelForgeJobPoller.loadJobId(TOOL_NAME);
    if (savedJobId) {
      showStage(convertingStage);
      watchJob(savedJobId);
      return;
    }

    // Restore the last completed result on a genuine reload, same as
    // the other tools — but only the result, never re-trigger a charge.
    if (window.PixelForgeJobPoller.isGenuineReload()) {
      const last = window.PixelForgeJobPoller.loadLastResult(TOOL_NAME);
      if (last) {
        showResult(last.outputUrl, last.filename || 'image');
        return;
      }
    } else {
      window.PixelForgeJobPoller.clearLastResult(TOOL_NAME);
    }

    showStage(uploadStage);
  }

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('is-dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-dragover');
    handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

  function handleFile(file) {
    clearError();
    if (!file || !file.type.match(/^image\/(png|jpeg|jpg|webp)/)) {
      showError('Please choose a PNG, JPG, or WebP image.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      showError(`This file is ${(file.size / 1024 / 1024).toFixed(1)}MB — the maximum allowed size is 30MB.`);
      return;
    }
    if (!getToken()) { showStage(authGate); return; }

    convertingFilename.textContent = file.name;
    showStage(convertingStage);
    uploadAndVectorize(file);
  }

  async function uploadAndVectorize(file) {
    const token = getToken();
    const form = new FormData();
    form.append('image', file);

    try {
      const res = await fetch('/api/tools/vectorize', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form
      });

      if (res.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        showStage(authGate);
        return;
      }

      const body = await res.json();
      if (!body.success) {
        showError(body.error || 'Could not start vectorization.');
        showStage(uploadStage);
        return;
      }

      window.PixelForgeJobPoller.saveJobId(TOOL_NAME, body.jobId);
      sessionStorage.setItem(`pixelforge_filename_${TOOL_NAME}`, file.name);
      watchJob(body.jobId);
    } catch (err) {
      showError('Could not reach the server. Check your connection and try again.');
      showStage(uploadStage);
    }
  }

  function watchJob(jobId) {
    window.PixelForgeJobPoller.poll(jobId, getToken(), {
      onCompleted: (outputUrl) => {
        window.PixelForgeJobPoller.clearJobId(TOOL_NAME);
        const filename = sessionStorage.getItem(`pixelforge_filename_${TOOL_NAME}`) || 'image';
        window.PixelForgeJobPoller.saveLastResult(TOOL_NAME, { outputUrl, filename });
        if (window.PixelForgeCreditsBadge) window.PixelForgeCreditsBadge.refresh();
        showResult(outputUrl, filename);
      },
      onFailed: (errorMessage) => {
        window.PixelForgeJobPoller.clearJobId(TOOL_NAME);
        showError(errorMessage || 'Vectorization failed. Please try again.');
        showStage(uploadStage);
      },
      onAuthError: () => {
        localStorage.removeItem(TOKEN_KEY);
        window.PixelForgeJobPoller.clearJobId(TOOL_NAME);
        showStage(authGate);
      }
    });
  }

  function showResult(outputUrl, filename) {
    const baseName = filename.replace(/\.[^.]+$/, '') || 'vector';
    resultFilename.textContent = filename;
    resultShapes.textContent = '';

    // The result is a hosted SVG file (Replicate output) rather than
    // inline markup, so it's shown as an image preview and downloaded
    // by fetching the actual file — unlike the old client-side version,
    // which had the raw SVG markup available locally to inject directly.
    resultPreview.innerHTML = `<img src="${outputUrl}" alt="Vectorized result" style="max-width:100%; max-height:100%; object-fit:contain;">`;
    downloadBtn.href = `/api/tools/download?url=${encodeURIComponent(outputUrl)}&filename=${encodeURIComponent(baseName + '.svg')}`;
    downloadBtn.removeAttribute('download');
    downloadBtn.setAttribute('download', `${baseName}.svg`);

    showStage(resultStage);
  }

  cancelBtn.addEventListener('click', () => {
    window.PixelForgeJobPoller.clearJobId(TOOL_NAME);
    fileInput.value = '';
    clearError();
    showStage(uploadStage);
  });

  startOverBtn.addEventListener('click', () => {
    window.PixelForgeJobPoller.clearLastResult(TOOL_NAME);
    fileInput.value = '';
    clearError();
    showStage(uploadStage);
  });

  init();
})();