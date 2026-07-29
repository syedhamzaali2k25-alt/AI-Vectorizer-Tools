(function () {
  const TOKEN_KEY = 'pixelforge_token';
  const TOOL_NAME = 'upscale';
  const { saveJobId, loadJobId, clearJobId, saveLastResult, loadLastResult, clearLastResult, isGenuineReload, poll } = window.PixelForgeJobPoller;

  const authGate = document.getElementById('auth-gate');

  const uploadStage = document.getElementById('upload-stage');
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const scaleButtons = document.querySelectorAll('.scale-btn');

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
  const beforeTag = document.getElementById('before-tag');
  const afterTag = document.getElementById('after-tag');
  const upscaleLoupe = document.getElementById('upscale-loupe');
  const loupeLabelBefore = document.getElementById('loupe-label-before');
  const loupeLabelAfter = document.getElementById('loupe-label-after');

  const errorBanner = document.getElementById('error-banner');

  let selectedScale = 2; // matches the "2x" button, which has is-active in the HTML by default
  let activePoll = null;
  let beforeCanvas = null;
  let afterCanvas = null;
  const LOUPE_HALF_SRC = 14;

  function showStage(stage) {
    [authGate, uploadStage, processingStage, resultStage].forEach((el) => el.classList.add('is-hidden'));
    stage.classList.remove('is-hidden');
  }
  function showError(message) {
    errorBanner.textContent = message;
    errorBanner.classList.remove('is-hidden');
  }
  function clearError() {
    errorBanner.classList.add('is-hidden');
  }
  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  scaleButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      scaleButtons.forEach((b) => {
        b.classList.remove('is-active', 'btn-primary');
        b.classList.add('btn-ghost');
      });
      btn.classList.remove('btn-ghost');
      btn.classList.add('is-active', 'btn-primary');
      selectedScale = Number(btn.dataset.scale);
    });
  });

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
      compareBefore.src = lastResult.outputUrl;
      compareAfter.src = lastResult.outputUrl;
      afterTag.textContent = 'After';
      downloadBtn.href = `/api/tools/download?url=${encodeURIComponent(lastResult.outputUrl)}&filename=upscaled.png`;
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
    beforeTag.textContent = 'Before';
    beforeCanvas = null;
    compareBefore.onload = () => {
      beforeTag.textContent = `Before · ${compareBefore.naturalWidth}×${compareBefore.naturalHeight}px`;
      const c = document.createElement('canvas');
      c.width = compareBefore.naturalWidth;
      c.height = compareBefore.naturalHeight;
      c.getContext('2d').drawImage(compareBefore, 0, 0);
      beforeCanvas = c;
    };
    showStage(processingStage);

    const token = getToken();
    if (!token) { showStage(authGate); return; }

    try {
      const form = new FormData();
      form.append('image', file);
      form.append('scale', String(selectedScale));

      const res = await fetch('/api/tools/upscale', {
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

  async function buildAfterCanvasViaProxy(outputUrl) {
    try {
      const proxyUrl = `/api/tools/download?url=${encodeURIComponent(outputUrl)}&filename=upscaled-for-loupe.png`;
      const res = await fetch(proxyUrl);
      if (!res.ok) return;
      const blob = await res.blob();
      const img = new Image();
      const objectUrl = URL.createObjectURL(blob);
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = objectUrl;
      });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      afterCanvas = c;
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      // loupe just won't show detail for this result — main slider still works
    }
  }

  function watchJob(jobId) {
    const token = getToken();
    if (!token) { showStage(authGate); return; }

    activePoll = poll(jobId, token, {
      onCompleted: (outputUrl) => {
        clearJobId(TOOL_NAME);
        compareAfter.src = outputUrl;
        afterTag.textContent = 'After';
        afterCanvas = null;
        compareAfter.onload = () => {
          afterTag.textContent = `After · ${compareAfter.naturalWidth}×${compareAfter.naturalHeight}px`;
        };
        buildAfterCanvasViaProxy(outputUrl);
        downloadBtn.href = `/api/tools/download?url=${encodeURIComponent(outputUrl)}&filename=upscaled.png`;
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

  function getContainedRect(frameW, frameH, naturalW, naturalH) {
    const frameAspect = frameW / frameH;
    const imgAspect = naturalW / naturalH;
    let renderW, renderH, offsetX, offsetY;
    if (imgAspect > frameAspect) {
      renderW = frameW;
      renderH = frameW / imgAspect;
      offsetX = 0;
      offsetY = (frameH - renderH) / 2;
    } else {
      renderH = frameH;
      renderW = frameH * imgAspect;
      offsetX = (frameW - renderW) / 2;
      offsetY = 0;
    }
    return { x: offsetX, y: offsetY, width: renderW, height: renderH };
  }

  function drawUpscaleLoupe(displayX, displayY) {
    if (!beforeCanvas || !afterCanvas || !upscaleLoupe) return;

    const frameRect = compareFrame.getBoundingClientRect();
    const rect = getContainedRect(frameRect.width, frameRect.height, beforeCanvas.width, beforeCanvas.height);

    if (displayX < rect.x || displayX > rect.x + rect.width || displayY < rect.y || displayY > rect.y + rect.height) {
      upscaleLoupe.style.display = 'none';
      if (loupeLabelBefore) loupeLabelBefore.style.display = 'none';
      if (loupeLabelAfter) loupeLabelAfter.style.display = 'none';
      return;
    }

    const beforeSrcX = ((displayX - rect.x) / rect.width) * beforeCanvas.width;
    const beforeSrcY = ((displayY - rect.y) / rect.height) * beforeCanvas.height;
    const afterSrcX = ((displayX - rect.x) / rect.width) * afterCanvas.width;
    const afterSrcY = ((displayY - rect.y) / rect.height) * afterCanvas.height;

    const lctx = upscaleLoupe.getContext('2d');
    lctx.clearRect(0, 0, upscaleLoupe.width, upscaleLoupe.height);
    lctx.imageSmoothingEnabled = false;

    lctx.drawImage(
      beforeCanvas,
      beforeSrcX - LOUPE_HALF_SRC, beforeSrcY - LOUPE_HALF_SRC, LOUPE_HALF_SRC * 2, LOUPE_HALF_SRC * 2,
      0, 0, 110, 110
    );
    lctx.drawImage(
      afterCanvas,
      afterSrcX - LOUPE_HALF_SRC, afterSrcY - LOUPE_HALF_SRC, LOUPE_HALF_SRC * 2, LOUPE_HALF_SRC * 2,
      110, 0, 110, 110
    );

    lctx.strokeStyle = 'rgba(255,255,255,0.5)';
    lctx.lineWidth = 1;
    lctx.beginPath();
    lctx.moveTo(110, 0);
    lctx.lineTo(110, 110);
    lctx.stroke();

    let left = displayX - upscaleLoupe.width / 2;
    let top = displayY - upscaleLoupe.height - 24;
    if (top < 0) top = displayY + 24;
    left = Math.max(4, Math.min(left, frameRect.width - upscaleLoupe.width - 4));

    upscaleLoupe.style.left = `${left}px`;
    upscaleLoupe.style.top = `${top}px`;
    upscaleLoupe.style.display = 'block';

    if (loupeLabelBefore) {
      loupeLabelBefore.style.left = `${left + 6}px`;
      loupeLabelBefore.style.top = `${top + 92}px`;
      loupeLabelBefore.style.display = 'block';
    }
    if (loupeLabelAfter) {
      loupeLabelAfter.style.left = `${left + 118}px`;
      loupeLabelAfter.style.top = `${top + 92}px`;
      loupeLabelAfter.style.display = 'block';
    }
  }

  compareFrame.addEventListener('mousemove', (e) => {
    const rect = compareFrame.getBoundingClientRect();
    drawUpscaleLoupe(e.clientX - rect.left, e.clientY - rect.top);
  });
  compareFrame.addEventListener('mouseleave', () => {
    if (upscaleLoupe) upscaleLoupe.style.display = 'none';
    if (loupeLabelBefore) loupeLabelBefore.style.display = 'none';
    if (loupeLabelAfter) loupeLabelAfter.style.display = 'none';
  });

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