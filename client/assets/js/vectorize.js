(function () {
  const TOKEN_KEY = 'pixelforge_token';

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

  const MAX_PROCESS_DIM = 1200;
  const MIN_LOADER_MS = 650;

  let baseName = 'vector';
  let currentSVG = '';
  let cancelled = false;

  function showStage(stage) {
    [authGate, uploadStage, convertingStage, resultStage].forEach((el) => el.classList.add('is-hidden'));
    stage.classList.remove('is-hidden');
  }
  function showError(msg) { errorBanner.textContent = msg; errorBanner.classList.remove('is-hidden'); }
  function clearError() { errorBanner.classList.add('is-hidden'); }
  function getToken() { return localStorage.getItem(TOKEN_KEY); }

  function init() {
    showStage(getToken() ? uploadStage : authGate);
  }


  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('is-dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-dragover');
    readFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', (e) => readFile(e.target.files[0]));

  function fitWithinMax(w, h, maxDim) {
    if (w <= maxDim && h <= maxDim) return { width: w, height: h };
    const scale = maxDim / Math.max(w, h);
    return { width: Math.round(w * scale), height: Math.round(h * scale) };
  }

  const MAX_FILE_BYTES = 30 * 1024 * 1024;

  function readFile(file) {
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
    cancelled = false;

    baseName = file.name.replace(/\.[^.]+$/, '') || 'vector';
    convertingFilename.textContent = file.name;
    showStage(convertingStage);

    const img = new Image();
    const reader = new FileReader();

    reader.onload = (e) => {
      img.onload = () => {
        const startedAt = Date.now();
        const { width, height } = fitWithinMax(img.naturalWidth, img.naturalHeight, MAX_PROCESS_DIM);

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const data = ctx.getImageData(0, 0, width, height).data;

        const { svg, shapeCount, colorCount } = window.VectorTraceEngine.traceToSVG(
          { data, width, height }
        );

        const elapsed = Date.now() - startedAt;
        const remainingDelay = Math.max(0, MIN_LOADER_MS - elapsed);

        setTimeout(() => {
          if (cancelled) return;
          currentSVG = svg;
          resultPreview.innerHTML = svg;
          resultFilename.textContent = file.name;
          resultShapes.textContent = `${shapeCount} shape${shapeCount === 1 ? '' : 's'} · ${colorCount} colors`;

          const blob = new Blob([svg], { type: 'image/svg+xml' });
          downloadBtn.href = URL.createObjectURL(blob);
          downloadBtn.download = `${baseName}.svg`;

          showStage(resultStage);
        }, remainingDelay);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  cancelBtn.addEventListener('click', () => {
    cancelled = true;
    fileInput.value = '';
    currentSVG = '';
    clearError();
    showStage(uploadStage);
  });

  startOverBtn.addEventListener('click', () => {
    fileInput.value = '';
    currentSVG = '';
    clearError();
    showStage(uploadStage);
  });

  init();
})();