/**
 * Shared job-polling logic used by every AI tool page (Background Remover,
 * Upscaler, Watermark Remover, Image Expander). A "job" is created
 * server-side the instant processing starts and keeps running regardless
 * of whether this page is still open — saving the jobId here in
 * localStorage (not just a JS variable) is what lets a refresh, a closed
 * tab, or a dropped connection resume tracking it instead of losing both
 * the result and the credit that will be spent on success.
 */
(function () {
  const JOB_POLL_INTERVAL_MS = 2500;

  function jobStorageKey(toolName) {
    return `pixelforge_job_${toolName}`;
  }

  function saveJobId(toolName, jobId) {
    localStorage.setItem(jobStorageKey(toolName), String(jobId));
  }

  function loadJobId(toolName) {
    return localStorage.getItem(jobStorageKey(toolName));
  }

  function clearJobId(toolName) {
    localStorage.removeItem(jobStorageKey(toolName));
  }

  /**
   * Separate from the in-progress job tracking above: once a job
   * completes, its jobId gets cleared (correctly — no need to keep
   * polling something already finished). But without saving the actual
   * result somewhere, refreshing right after seeing a completed result
   * would lose the on-screen display entirely (not the underlying file
   * itself, which still exists server-side, but the "before/after" view
   * on this specific page) — reported as a real gap in testing. This
   * keeps the last completed result around until the user explicitly
   * starts a new one, so a refresh right after finishing still shows it.
   */
  function resultStorageKey(toolName) {
    return `pixelforge_result_${toolName}`;
  }

  function saveLastResult(toolName, data) {
    localStorage.setItem(resultStorageKey(toolName), JSON.stringify(data));
  }

  function loadLastResult(toolName) {
    const raw = localStorage.getItem(resultStorageKey(toolName));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (err) {
      return null; // corrupted/manually-edited value — treat as no saved result
    }
  }

  function clearLastResult(toolName) {
    localStorage.removeItem(resultStorageKey(toolName));
  }

  /**
   * Distinguishes an actual page refresh (F5 / Ctrl+R) from navigating
   * away and coming back (clicking a link, then Back) — both look
   * identical to a plain "did localStorage have something saved" check,
   * but users expect different behavior: a refresh shouldn't lose your
   * result, but deliberately navigating away and back to a tool feels
   * more like wanting a fresh start, not seeing the same result again.
   * Uses the standard Navigation Timing API; falls back to treating it
   * as NOT a reload if the API is unavailable (the safer default, since
   * showing a fresh upload screen is a smaller surprise than an
   * unexpectedly-reappearing old result).
   */
  function isGenuineReload() {
    try {
      const entries = performance.getEntriesByType('navigation');
      return entries.length > 0 && entries[0].type === 'reload';
    } catch (err) {
      return false;
    }
  }

  /**
   * Polls GET /api/jobs/:id every 2.5s until it resolves to completed or
   * failed. Returns a handle with .stop() so the caller (e.g. a Cancel
   * button) can stop watching without pretending to cancel the actual
   * server-side AI processing, which keeps running either way.
   */
  function poll(jobId, token, { onCompleted, onFailed, onAuthError }) {
    let stopped = false;
    let timeoutHandle = null;

    async function tick() {
      if (stopped) return;
      try {
        const res = await fetch(`/api/jobs/${jobId}`, {
          headers: { Authorization: `Bearer ${token}` }
        });

        if (res.status === 401) {
          if (!stopped) onAuthError();
          return;
        }

        const body = await res.json();

        if (body.status === 'completed') {
          if (!stopped) onCompleted(body.outputUrl);
          return;
        }
        if (body.status === 'failed') {
          if (!stopped) onFailed(body.error || 'Something went wrong processing this image.');
          return;
        }
        // still 'processing' — keep polling
        if (!stopped) timeoutHandle = setTimeout(tick, JOB_POLL_INTERVAL_MS);
      } catch (err) {
        // Network hiccup mid-poll — the job itself is still running
        // server-side regardless, so keep retrying rather than giving up
        // and showing a scary error for what's likely a transient blip.
        if (!stopped) timeoutHandle = setTimeout(tick, JOB_POLL_INTERVAL_MS);
      }
    }

    tick();

    return {
      stop() {
        stopped = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    };
  }

  window.PixelForgeJobPoller = {
    saveJobId, loadJobId, clearJobId,
    saveLastResult, loadLastResult, clearLastResult,
    isGenuineReload,
    poll
  };
})();