(function () {
  const TOKEN_KEY = 'pixelforge_token';
  const TOOL_NAME = 'expand';
  const { saveJobId, loadJobId, clearJobId, saveLastResult, loadLastResult, clearLastResult, isGenuineReload, poll } = window.PixelForgeJobPoller;

  const authGate = document.getElementById('auth-gate');

  const uploadStage = document.getElementById('upload-stage');
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');

  const setupStage = document.getElementById('setup-stage');
  const previewImg = document.getElementById('preview-img');
  const dirLeft = document.getElementById('dir-left');
  const dirRight = document.getElementById('dir-right');
  const dirUp = document.getElementById('dir-up');
  const dirDown = document.getElementById('dir-down');
  const promptInput = document.getElementById('prompt-input');
  const expandBtn = document.getElementById('expand-btn');
  const startOverBtn = document.getElementById('start-over-btn');

  const processingStage = document.getElementById('processing-stage');
  const cancelBtn = document.getElementById('cancel-btn');
  const setupRemoveBtn = document.getElementById('setup-remove-btn');

  const resultStage = document.getElementById('result-stage');
  const resultBefore = document.getElementById('result-before');
  const resultAfter = document.getElementById('result-after');
  const downloadBtn = document.getElementById('download-btn');
  const expandAgainBtn = document.getElementById('expand-again-btn');
  const creditsLabel = document.getElementById('credits-label');

  const errorBanner = document.getElementById('error-banner');

  let currentController = null;
  let activePoll = null;
  let currentFile = null;

  function showStage(stage) {
    [authGate, uploadStage, setupStage, processingStage, resultStage].forEach((el) => el.classList.add('is-hidden'));
    stage.classList.remove('is-hidden');
  }
  function showError(msg) { errorBanner.textContent = msg; errorBanner.classList.remove('is-hidden'); }
  function clearError() { errorBanner.classList.add('is-hidden'); }
  function getToken() { return localStorage.getItem(TOKEN_KEY); }

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
      resultBefore.src = lastResult.outputUrl;
      resultAfter.src = lastResult.outputUrl;
      downloadBtn.href = `/api/tools/download?url=${encodeURIComponent(lastResult.outputUrl)}&filename=expanded.png`;
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

  function handleFile(file) {
    clearError();
    if (!file || !file.type.match(/^image\/(png|jpeg|webp)/)) {
      showError('Please choose a PNG, JPG, or WebP image.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      showError(`This file is ${(file.size / 1024 / 1024).toFixed(1)}MB — the maximum allowed size is 15MB. Try compressing the image or using a smaller resolution.`);
      return;
    }
    currentFile = file;
    previewImg.src = URL.createObjectURL(file);
    resultBefore.src = previewImg.src;
    showStage(setupStage);
  }

  function buildPaddedImageAndMask(img, left, right, up, down) {
    const origW = img.naturalWidth;
    const origH = img.naturalHeight;
    const newW = origW + left + right;
    const newH = origH + up + down;

    const paddedCanvas = document.createElement('canvas');
    paddedCanvas.width = newW;
    paddedCanvas.height = newH;
    const paddedCtx = paddedCanvas.getContext('2d');
    paddedCtx.fillStyle = '#808080';
    paddedCtx.fillRect(0, 0, newW, newH);
    paddedCtx.drawImage(img, left, up, origW, origH);

    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = newW;
    maskCanvas.height = newH;
    const maskCtx = maskCanvas.getContext('2d');
    maskCtx.fillStyle = '#ffffff';
    maskCtx.fillRect(0, 0, newW, newH);
    maskCtx.fillStyle = '#000000';
    maskCtx.fillRect(left, up, origW, origH);

    return { paddedCanvas, maskCanvas };
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  expandBtn.addEventListener('click', async () => {
    clearError();
    const left = Number(dirLeft.value) || 0;
    const right = Number(dirRight.value) || 0;
    const up = Number(dirUp.value) || 0;
    const down = Number(dirDown.value) || 0;

    if (!left && !right && !up && !down) {
      showError('Choose at least one direction to expand.');
      return;
    }

    const MIN_USEFUL_PX = 100;
    const usedDirections = [left, right, up, down].filter((v) => v > 0);
    if (usedDirections.some((v) => v < MIN_USEFUL_PX)) {
      showError(`For good results, use at least ${MIN_USEFUL_PX}px on any side you're expanding — smaller amounts are often too narrow for AI to fill convincingly.`);
      return;
    }

    const token = getToken();
    if (!token) { showStage(authGate); return; }

    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = previewImg.src;
      });

      const originalArea = img.naturalWidth * img.naturalHeight;
      const newTotalWidth = img.naturalWidth + left + right;
      const newTotalHeight = img.naturalHeight + up + down;
      const newArea = newTotalWidth * newTotalHeight;
      const addedArea = newArea - originalArea;
      const MAX_ADDED_AREA_RATIO = 2;
      if (addedArea > originalArea * MAX_ADDED_AREA_RATIO) {
        showError('This expansion is large relative to your photo — AI outpainting works best when the new area added isn\'t dramatically bigger than the original. Try smaller amounts, or expand in a couple of smaller steps instead of one big jump.');
        return;
      }

      showStage(processingStage);

      const { paddedCanvas, maskCanvas } = buildPaddedImageAndMask(img, left, right, up, down);
      const [paddedBlob, maskBlob] = await Promise.all([
        canvasToBlob(paddedCanvas),
        canvasToBlob(maskCanvas)
      ]);

      const form = new FormData();
      form.append('image', paddedBlob, 'padded.png');
      form.append('mask', maskBlob, 'mask.png');
      if (promptInput.value.trim()) form.append('prompt', promptInput.value.trim());

      currentController = new AbortController();
      const res = await fetch('/api/tools/expand', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        signal: currentController.signal
      });

      const body = await res.json();

      if (res.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        showStage(authGate);
        showError('Your session expired or the token is invalid. Please sign in again.');
        return;
      }

      if (!body.success) {
        showStage(setupStage);
        showError(body.error || 'Something went wrong processing this image.');
        return;
      }

      saveJobId(TOOL_NAME, body.jobId);
      watchJob(body.jobId);
    } catch (err) {
      if (err.name === 'AbortError') return;
      showStage(setupStage);
      showError('Could not reach the server. Check your connection and try again.');
    }
  });

  function watchJob(jobId) {
    const token = getToken();
    if (!token) {
      showStage(authGate);
      return;
    }

    activePoll = poll(jobId, token, {
      onCompleted: (outputUrl) => {
        clearJobId(TOOL_NAME);
        resultAfter.src = outputUrl;
        downloadBtn.href = `/api/tools/download?url=${encodeURIComponent(outputUrl)}&filename=expanded.png`;
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
        showError('Your session expired. Please sign in again — your image is still processing and its credits are safe either way.');
      }
    });
  }

  function resetAll() {
    if (currentController) currentController.abort();
    if (activePoll) activePoll.stop();
    clearJobId(TOOL_NAME);
    clearLastResult(TOOL_NAME);
    fileInput.value = '';
    currentFile = null;
    dirLeft.value = 0; dirRight.value = 0; dirUp.value = 0; dirDown.value = 0;
    promptInput.value = '';
    clearError();
    showStage(uploadStage);
  }

  cancelBtn.addEventListener('click', resetAll);
  setupRemoveBtn.addEventListener('click', resetAll);
  startOverBtn.addEventListener('click', resetAll);
  expandAgainBtn.addEventListener('click', resetAll);

  init();
})();