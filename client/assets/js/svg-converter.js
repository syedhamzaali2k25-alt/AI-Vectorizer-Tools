(function () {
  const TOKEN_KEY = 'pixelforge_token';

  const authGate = document.getElementById('auth-gate');

  const uploadStage = document.getElementById('upload-stage');
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const modeButtons = document.querySelectorAll('.mode-btn');
  const modeExplainer = document.getElementById('mode-explainer');

  const MODE_TEXT = {
    trace: 'Traces the image into flat-color vector shapes — smaller file, but some color shift is unavoidable (SVG shapes can only be flat colors).',
    embed: 'Wraps your original image inside the SVG file, unchanged — exact colors, but this isn\'t actually vector-traced (it won\'t scale/edit like true vector shapes, and the file is larger).'
  };
  let currentMode = 'trace';

  const convertingStage = document.getElementById('converting-stage');
  const cancelBtn = document.getElementById('cancel-btn');
  const convertingFilename = document.getElementById('converting-filename');

  const resultStage = document.getElementById('result-stage');
  const resultPreview = document.getElementById('result-preview');
  const resultFilename = document.getElementById('result-filename');
  const resultShapes = document.getElementById('result-shapes');
  const downloadBtn = document.getElementById('download-btn');
  const startOverBtn = document.getElementById('start-over-btn');

  const errorBanner = document.getElementById('error-banner');

  // This tool's "processing" is local/synchronous (Potrace tracing runs
  // on the main thread), not a network request — so there's nothing to
  // truly abort mid-flight. Cancel instead just discards the eventual
  // result and returns to upload immediately, rather than making the
  // user wait for the in-progress computation to finish.
  let cancelled = false;

  const MAX_PROCESS_DIM = 1200;
  const MIN_LOADER_MS = 650;

  let baseName = 'vector';
  let currentSVG = '';

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

  modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      modeButtons.forEach((b) => {
        b.classList.remove('btn-primary', 'is-active');
        b.classList.add('btn-ghost');
      });
      btn.classList.remove('btn-ghost');
      btn.classList.add('btn-primary', 'is-active');
      currentMode = btn.dataset.mode;
      modeExplainer.textContent = MODE_TEXT[currentMode];
    });
  });

  function fitWithinMax(w, h, maxDim) {
    if (w <= maxDim && h <= maxDim) return { width: w, height: h };
    const scale = maxDim / Math.max(w, h);
    return { width: Math.round(w * scale), height: Math.round(h * scale) };
  }

  const MAX_FILE_BYTES = 30 * 1024 * 1024; // more generous than the paid tools' 15MB since this is 100% client-side (no server cost) — just guarding against a pathologically huge file freezing the browser during the initial decode, before our own MAX_PROCESS_DIM downscaling kicks in

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

    if (currentMode === 'embed') {
      embedFile(file);
      return;
    }
    traceFile(file);
  }

  // "Exact colors" mode: wraps the original raster image inside an SVG
  // <image> element. This is NOT vector tracing — it's the same pixels,
  // unchanged, just packaged in an .svg file — so colors are exact by
  // construction, at the cost of it not really being a scalable vector.
  function embedFile(file) {
    const startedAt = Date.now();
    const img = new Image();
    const reader = new FileReader();

    reader.onload = (e) => {
      const dataUrl = e.target.result;
      img.onload = () => {
        const width = img.naturalWidth;
        const height = img.naturalHeight;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n`
          + `\t<image href="${dataUrl}" x="0" y="0" width="${width}" height="${height}"/>\n`
          + `</svg>`;

        const elapsed = Date.now() - startedAt;
        const remainingDelay = Math.max(0, MIN_LOADER_MS - elapsed);

        setTimeout(() => {
          finishConversion(svg, file.name, '1 embedded image (exact colors)');
        }, remainingDelay);
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }

  function finishConversion(svg, filename, shapesLabel) {
    if (cancelled) return; // user clicked Cancel while this was still processing
    currentSVG = svg;
    resultPreview.innerHTML = svg;
    resultFilename.textContent = filename;
    resultShapes.textContent = shapesLabel;

    const blob = new Blob([svg], { type: 'image/svg+xml' });
    downloadBtn.href = URL.createObjectURL(blob);
    downloadBtn.download = `${baseName}.svg`;

    showStage(resultStage);
  }

  function traceFile(file) {
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

        // Vector Trace Engine v2: LAB color quantization (perceptually
        // accurate), adaptive color count (8-64 by default, scales with
        // image complexity), edge-aware sampling, similar-region merging,
        // transparency preservation, and SVG path size optimization.
        // See vector-trace-engine.js for full details on what each part
        // does and its tested tradeoffs.
        const { svg, shapeCount, colorCount } = window.VectorTraceEngine.traceToSVG(
          { data, width, height }
        );

        const elapsed = Date.now() - startedAt;
        const remainingDelay = Math.max(0, MIN_LOADER_MS - elapsed);

        setTimeout(() => {
          finishConversion(svg, file.name, `${shapeCount} shape${shapeCount === 1 ? '' : 's'} · ${colorCount} colors`);
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