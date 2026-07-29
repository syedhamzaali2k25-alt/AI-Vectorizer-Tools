(function () {
  const TOKEN_KEY = 'pixelforge_token';
  const TOOL_NAME = 'watermark-remove';
  const { saveJobId, loadJobId, clearJobId, saveLastResult, loadLastResult, clearLastResult, isGenuineReload, poll } = window.PixelForgeJobPoller;

  const authGate = document.getElementById('auth-gate');

  const uploadStage = document.getElementById('upload-stage');
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');

  const processingStage = document.getElementById('processing-stage');
  const cancelBtn = document.getElementById('cancel-btn');

  const resultStage = document.getElementById('result-stage');
  const compareFrame = document.getElementById('compare-frame');
  const compareBefore = document.getElementById('compare-before');
  const compareAfter = document.getElementById('compare-after');
  const compareDivider = document.getElementById('compare-divider');
  const downloadBtn = document.getElementById('download-btn');
  const startOverBtn = document.getElementById('start-over-btn');
  const creditsLabel = document.getElementById('credits-label');

  const errorBanner = document.getElementById('error-banner');

  let activePoll = null;

  function showStage(stage) {
    [authGate, uploadStage, processingStage, resultStage].forEach((el) => el.classList.add('is-hidden'));
    stage.classList.remove('is-hidden');
  }
  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.classList.remove('is-hidden');
  }
  function clearError() {
    errorBanner.classList.add('is-hidden');
  }
  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function init() {
    if (!getToken()) {
      showStage(authGate);
      return;
    }
    const existingJobId = loadJobId(TOOL_NAME);
    if (existingJobId) {
      showStage(processingStage);
      watchJob(existingJobId);
      return;
    }
    const lastResult = loadLastResult(TOOL_NAME);
    if (lastResult && isGenuineReload()) {
      // outputUrl here is a data: URL (base64) — same-origin by nature,
      // so no CORS/broken-image concern, but still no real "before" to
      // restore, so use the same image on both sides for consistency
      // with how the other tools handle this same restore scenario.
      compareBefore.src = lastResult.outputUrl;
      compareAfter.src = lastResult.outputUrl;
      downloadBtn.href = lastResult.outputUrl;
      setComparePct(0);
      showStage(resultStage);
      return;
    }
    if (lastResult) clearLastResult(TOOL_NAME);
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

  const MAX_FILE_BYTES = 15 * 1024 * 1024;

  async function handleFile(file) {
    clearError();
    if (!file || !file.type.match(/^image\/(png|jpeg|webp)/)) {
      showError('Please choose a PNG, JPG, or WebP image.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      showError(`This file is ${(file.size / 1024 / 1024).toFixed(1)}MB — the maximum allowed size is 15MB. Try compressing the image or using a smaller resolution.`);
      return;
    }

    compareBefore.src = URL.createObjectURL(file);
    showStage(processingStage);

    const token = getToken();
    if (!token) {
      showStage(authGate);
      return;
    }

    try {
      const form = new FormData();
      form.append('image', file);

      const res = await fetch('/api/tools/watermark-remove', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form
      });

      const body = await res.json();

      if (res.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        showStage(authGate);
        showError('Your session expired or the token is invalid. Please sign in again.');
        return;
      }

      if (!body.success) {
        showStage(uploadStage);
        showError(body.error || 'Something went wrong processing this image.');
        return;
      }

      saveJobId(TOOL_NAME, body.jobId);
      watchJob(body.jobId);
    } catch (err) {
      showStage(uploadStage);
      showError('Could not reach the server. Check your connection and try again.');
    }
  }

  function watchJob(jobId) {
    const token = getToken();
    if (!token) {
      showStage(authGate);
      return;
    }

    activePoll = poll(jobId, token, {
      onCompleted: (outputUrl) => {
        clearJobId(TOOL_NAME);
        compareAfter.src = outputUrl;
        downloadBtn.href = outputUrl;
        setComparePct(50);
        showStage(resultStage);
        saveLastResult(TOOL_NAME, { outputUrl });
        if (window.PixelForgeCreditsBadge) window.PixelForgeCreditsBadge.refresh();
      },
      onFailed: (errorMessage) => {
        clearJobId(TOOL_NAME);
        showStage(uploadStage);
        showError(errorMessage);
      },
      onAuthError: () => {
        clearJobId(TOOL_NAME);
        localStorage.removeItem(TOKEN_KEY);
        showStage(authGate);
        showError('Your session expired. Please sign in again — your image is still processing and its credit is safe either way.');
      }
    });
  }

  function setComparePct(pct) {
    pct = Math.max(0, Math.min(100, pct));
    compareBefore.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    compareDivider.style.left = `${pct}%`;
  }

  function compareFromClientX(clientX) {
    const rect = compareFrame.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setComparePct(pct);
  }

  let dragging = false;
  compareFrame.addEventListener('mousedown', (e) => { dragging = true; compareFromClientX(e.clientX); });
  window.addEventListener('mousemove', (e) => { if (dragging) compareFromClientX(e.clientX); });
  window.addEventListener('mouseup', () => { dragging = false; });
  compareFrame.addEventListener('touchstart', (e) => { dragging = true; compareFromClientX(e.touches[0].clientX); });
  window.addEventListener('touchmove', (e) => { if (dragging) compareFromClientX(e.touches[0].clientX); });
  window.addEventListener('touchend', () => { dragging = false; });

  cancelBtn.addEventListener('click', () => {
    if (activePoll) activePoll.stop();
    clearJobId(TOOL_NAME);
    fileInput.value = '';
    clearError();
    showStage(uploadStage);
  });

  startOverBtn.addEventListener('click', () => {
    clearLastResult(TOOL_NAME);
    fileInput.value = '';
    clearError();
    showStage(uploadStage);
  });

  init();
})();