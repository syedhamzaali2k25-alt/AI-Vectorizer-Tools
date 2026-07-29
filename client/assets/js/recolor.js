(function () {
  const TOKEN_KEY = 'pixelforge_token';

  const authGate = document.getElementById('auth-gate');
 
  const uploadStage = document.getElementById('upload-stage');
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');

  const editStage = document.getElementById('edit-stage');
  const pickFrame = document.getElementById('pick-frame');
  const pickCanvas = document.getElementById('pick-canvas');
  const loupeCanvas = document.getElementById('loupe-canvas');

  const pickedSwatch = document.getElementById('picked-swatch');
  const newColorInput = document.getElementById('new-color');
  const toleranceSlider = document.getElementById('tolerance-slider');
  const toleranceValue = document.getElementById('tolerance-value');
  const pickHint = document.getElementById('pick-hint');

  const downloadBtn = document.getElementById('download-btn');
  const startOverBtn = document.getElementById('start-over-btn');
  const errorBanner = document.getElementById('error-banner');

  const MAX_DIM = 1400;
  const LOUPE_ZOOM = 9;
  const LOUPE_RADIUS = 5;

  let originalImageData = null;
  let targetRGB = null;

  function showStage(stage) {
    [authGate, uploadStage, editStage].forEach((el) => el.classList.add('is-hidden'));
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
    handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

  function handleFile(file) {
    clearError();
    if (!file || !file.type.match(/^image\/(png|jpeg|webp)/)) {
      showError('Please choose a PNG, JPG, or WebP image.');
      return;
    }

    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => {
      img.onload = () => {
        let width = img.naturalWidth;
        let height = img.naturalHeight;
        if (width > MAX_DIM || height > MAX_DIM) {
          const scale = MAX_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }

        pickCanvas.width = width;
        pickCanvas.height = height;
        const ctx = pickCanvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        originalImageData = ctx.getImageData(0, 0, width, height);

        targetRGB = null;
        pickedSwatch.style.background = '#222';
        pickHint.textContent = 'Click a color on the image above to select it';
        showStage(editStage);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function canvasCoordsFromEvent(e) {
    const rect = pickCanvas.getBoundingClientRect();
    const scaleX = pickCanvas.width / rect.width;
    const scaleY = pickCanvas.height / rect.height;
    return {
      x: Math.floor((e.clientX - rect.left) * scaleX),
      y: Math.floor((e.clientY - rect.top) * scaleY)
    };
  }

  function drawLoupe(x, y) {
    const w = originalImageData.width, h = originalImageData.height;
    const lctx = loupeCanvas.getContext('2d');
    lctx.clearRect(0, 0, loupeCanvas.width, loupeCanvas.height);
    lctx.fillStyle = '#000';
    lctx.fillRect(0, 0, loupeCanvas.width, loupeCanvas.height);

    const ctx = pickCanvas.getContext('2d');
    for (let dy = -LOUPE_RADIUS; dy <= LOUPE_RADIUS; dy++) {
      for (let dx = -LOUPE_RADIUS; dx <= LOUPE_RADIUS; dx++) {
        const px = x + dx, py = y + dy;
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const pixel = ctx.getImageData(px, py, 1, 1).data;
        lctx.fillStyle = `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`;
        lctx.fillRect((dx + LOUPE_RADIUS) * LOUPE_ZOOM, (dy + LOUPE_RADIUS) * LOUPE_ZOOM, LOUPE_ZOOM, LOUPE_ZOOM);
      }
    }
    lctx.strokeStyle = '#6D5EF7';
    lctx.lineWidth = 2;
    lctx.strokeRect(LOUPE_RADIUS * LOUPE_ZOOM, LOUPE_RADIUS * LOUPE_ZOOM, LOUPE_ZOOM, LOUPE_ZOOM);

    const frameRect = pickFrame.getBoundingClientRect();
    const canvasRect = pickCanvas.getBoundingClientRect();
    const scaleX = canvasRect.width / pickCanvas.width;
    const scaleY = canvasRect.height / pickCanvas.height;
    const cssX = (canvasRect.left - frameRect.left) + x * scaleX;
    const cssY = (canvasRect.top - frameRect.top) + y * scaleY;

    let left = cssX - loupeCanvas.width / 2;
    let top = cssY - loupeCanvas.height - 24;
    if (top < 0) top = cssY + 24;
    left = Math.max(4, Math.min(left, frameRect.width - loupeCanvas.width - 4));

    loupeCanvas.style.left = `${left}px`;
    loupeCanvas.style.top = `${top}px`;
    loupeCanvas.style.display = 'block';
  }
  function hideLoupe() { loupeCanvas.style.display = 'none'; }

  function pickColor(e) {
    const { x, y } = canvasCoordsFromEvent(e);
    const ctx = pickCanvas.getContext('2d');
    const pixel = ctx.getImageData(x, y, 1, 1).data;
    targetRGB = [pixel[0], pixel[1], pixel[2]];
    pickedSwatch.style.background = `rgb(${targetRGB[0]}, ${targetRGB[1]}, ${targetRGB[2]})`;
    pickHint.textContent = `Selected rgb(${targetRGB[0]}, ${targetRGB[1]}, ${targetRGB[2]}) — adjust replacement or tolerance below`;
    process();
  }

  pickCanvas.addEventListener('click', pickColor);
  pickCanvas.addEventListener('mousemove', (e) => {
    if (!originalImageData) return;
    const { x, y } = canvasCoordsFromEvent(e);
    if (x < 0 || y < 0 || x >= pickCanvas.width || y >= pickCanvas.height) { hideLoupe(); return; }
    drawLoupe(x, y);
  });
  pickCanvas.addEventListener('mouseleave', hideLoupe);

  function hexToRgb(hex) {
    const v = hex.replace('#', '');
    return [parseInt(v.substring(0, 2), 16), parseInt(v.substring(2, 4), 16), parseInt(v.substring(4, 6), 16)];
  }

  function process() {
    if (!originalImageData || !targetRGB) return;
    const tolerance = Number(toleranceSlider.value);
    const newRGB = hexToRgb(newColorInput.value);
    const data = new Uint8ClampedArray(originalImageData.data);

    for (let i = 0; i < data.length; i += 4) {
      const dr = data[i] - targetRGB[0];
      const dg = data[i + 1] - targetRGB[1];
      const db = data[i + 2] - targetRGB[2];
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      if (dist <= tolerance) {
        const weight = tolerance === 0 ? 1 : 1 - dist / tolerance;
        data[i] = data[i] * (1 - weight) + newRGB[0] * weight;
        data[i + 1] = data[i + 1] * (1 - weight) + newRGB[1] * weight;
        data[i + 2] = data[i + 2] * (1 - weight) + newRGB[2] * weight;
      }
    }

    const result = new ImageData(data, originalImageData.width, originalImageData.height);
    pickCanvas.getContext('2d').putImageData(result, 0, 0);
  }

  toleranceSlider.addEventListener('input', () => {
    toleranceValue.textContent = toleranceSlider.value;
    process();
  });
  newColorInput.addEventListener('input', process);

  startOverBtn.addEventListener('click', () => {
    fileInput.value = '';
    originalImageData = null;
    targetRGB = null;
    clearError();
    showStage(uploadStage);
  });

  downloadBtn.addEventListener('click', () => {
    pickCanvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'recolored.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }, 'image/png');
  });

  init();
})();
