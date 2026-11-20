// Lightweight in-memory job tracker with persistence of the last runs per app.
// Long-running work (crawling, analysis, REA) runs detached and reports progress;
// the dashboard polls GET /api/apps/:id/jobs/:jobId.
import { newId, nowIso } from './util.js';

const jobs = new Map(); // jobId -> job
const MAX_JOBS_KEPT = 200;

export function createJob(appId, type, label = '') {
  const job = {
    id: newId('job'),
    appId,
    type,
    label,
    status: 'running',
    progress: 0,
    steps: [],
    result: null,
    error: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  jobs.set(job.id, job);
  if (jobs.size > MAX_JOBS_KEPT) {
    const oldest = [...jobs.entries()].sort((a, b) => (a[1].createdAt < b[1].createdAt ? -1 : 1))[0];
    if (oldest) jobs.delete(oldest[0]);
  }
  return job;
}

export function jobStep(job, name, detail = '', progress = null) {
  job.steps.push({ name, detail, at: nowIso() });
  if (progress !== null) job.progress = Math.max(job.progress, Math.min(100, Math.round(progress)));
  job.updatedAt = nowIso();
}

export function finishJob(job, result = {}) {
  job.status = 'done';
  job.progress = 100;
  job.result = result;
  job.updatedAt = nowIso();
}

export function failJob(job, error) {
  job.status = 'failed';
  job.error = String(error?.message || error || 'unknown error');
  job.updatedAt = nowIso();
}

/** Persist a job summary into the app record (upsert by id, latest 8). */
export function recordJob(store, app, job) {
  app.jobs = (Array.isArray(app.jobs) ? app.jobs : []).filter((j) => j.id !== job.id);
  app.jobs.unshift({
    id: job.id,
    type: job.type,
    label: job.label,
    status: job.status,
    progress: job.progress,
    error: job.error,
    steps: job.steps.slice(-6),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });
  app.jobs = app.jobs.slice(0, 8);
  store.saveApp(app);
}

export function getJob(appId, jobId) {
  const job = jobs.get(jobId);
  return job && job.appId === appId ? job : null;
}
