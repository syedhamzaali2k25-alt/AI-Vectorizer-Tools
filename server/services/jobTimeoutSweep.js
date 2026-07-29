/**
 * Job timeout safety net.
 *
 * Every AI job normally resolves to 'completed' or 'failed' once
 * Replicate/Dewatermark responds. But if that response never comes back
 * at all — a hung request, a Replicate outage, a dropped connection
 * between our server and theirs — a job would otherwise stay in
 * 'processing' forever, with the frontend polling endlessly and the
 * user seeing an infinite spinner with no way to know something went
 * wrong.
 *
 * This runs a periodic sweep that finds any job stuck in 'processing'
 * for longer than a reasonable timeout and marks it 'failed' — no
 * credits are deducted (failures never deduct credits, matching every
 * other failure path in the system), and the user's next poll simply
 * sees a clear failure instead of waiting forever.
 */

const AiUsage = require('../models/AiUsage');

const JOB_TIMEOUT_MINUTES = 5; // generous — every tool normally finishes in well under a minute
const SWEEP_INTERVAL_MS = 60 * 1000; // check once a minute

async function sweepStaleJobs() {
  try {
    const staleJobs = await AiUsage.findStaleProcessingJobs(JOB_TIMEOUT_MINUTES);
    for (const job of staleJobs) {
      await AiUsage.markJobFailed(
        job.id,
        `Processing timed out after ${JOB_TIMEOUT_MINUTES} minutes. This is unusual — please try again.`
      );
      console.log(`[job-timeout-sweep] Marked stuck job ${job.id} as failed (exceeded ${JOB_TIMEOUT_MINUTES}min timeout).`);
    }
  } catch (err) {
    // A failed sweep attempt shouldn't crash the server or stop future
    // sweeps — just log it and let the next interval try again.
    console.error('[job-timeout-sweep] Error while checking for stale jobs:', err);
  }
}

function startJobTimeoutSweep() {
  setInterval(sweepStaleJobs, SWEEP_INTERVAL_MS);
  console.log(`[job-timeout-sweep] Started — checking every ${SWEEP_INTERVAL_MS / 1000}s for jobs stuck in processing beyond ${JOB_TIMEOUT_MINUTES} minutes.`);
}

module.exports = { startJobTimeoutSweep, sweepStaleJobs, JOB_TIMEOUT_MINUTES };