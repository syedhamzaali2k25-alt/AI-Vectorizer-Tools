/* K-means color quantization: reduces an image to N dominant colors
 * so each color can be traced as its own separate vector shape.
 */

function kMeansQuantize(data, w, h, k, sampleSize) {
  sampleSize = sampleSize || 6000;
  const total = w * h;
  const step = Math.max(1, Math.floor(total / sampleSize));
  const samples = [];

  for (let i = 0; i < total; i += step) {
    const idx = i * 4;
    if (data[idx + 3] < 16) continue; // skip near-transparent pixels
    samples.push([data[idx], data[idx + 1], data[idx + 2]]);
  }

  if (samples.length === 0) {
    samples.push([255, 255, 255]);
  }

  function dist2(a, b) {
    const dr = a[0] - b[0];
    const dg = a[1] - b[1];
    const db = a[2] - b[2];
    return dr * dr + dg * dg + db * db;
  }

  const effectiveK = Math.min(k, samples.length);

  // k-means++ seeding
  const centers = [samples[Math.floor(Math.random() * samples.length)].slice()];
  while (centers.length < effectiveK) {
    const dists = samples.map((s) => {
      let minD = Infinity;
      for (const c of centers) minD = Math.min(minD, dist2(s, c));
      return minD;
    });
    const sum = dists.reduce((a, b) => a + b, 0);
    if (sum === 0) {
      centers.push(samples[Math.floor(Math.random() * samples.length)].slice());
      continue;
    }
    let r = Math.random() * sum;
    let idx = 0;
    for (; idx < dists.length; idx++) {
      r -= dists[idx];
      if (r <= 0) break;
    }
    centers.push(samples[Math.min(idx, samples.length - 1)].slice());
  }

  for (let iter = 0; iter < 10; iter++) {
    const sums = Array.from({ length: effectiveK }, () => [0, 0, 0, 0]);
    for (const s of samples) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < effectiveK; c++) {
        const d = dist2(s, centers[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      sums[best][0] += s[0];
      sums[best][1] += s[1];
      sums[best][2] += s[2];
      sums[best][3] += 1;
    }
    for (let c = 0; c < effectiveK; c++) {
      if (sums[c][3] > 0) {
        centers[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
      }
    }
  }

  const labels = new Int32Array(total);
  for (let i = 0; i < total; i++) {
    const idx = i * 4;
    const px = [data[idx], data[idx + 1], data[idx + 2]];
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < effectiveK; c++) {
      const d = dist2(px, centers[c]);
      if (d < bestD) { bestD = d; best = c; }
    }
    labels[i] = best;
  }

  return { centers, labels };
}

function rgbToHex(rgb) {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

window.ColorQuantize = { kMeansQuantize, rgbToHex };