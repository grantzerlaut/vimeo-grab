// Offscreen page: downloads HLS segments and assembles them into one MP4.
// It only talks to the service worker; it has no access to tabs or storage.
import {downloadHls} from '../lib/stream.mjs';
import {OpfsSink, MemorySink, clearTemp, removeTemp, freeSpace} from '../lib/sink.mjs';
import {secondsUntilExpiry} from '../lib/vimeo.mjs';

const WORKER_URL = chrome.runtime.getURL('background.js');
const queue = [];
const running = new Map(); // job id -> {attempt, controller}
const saved = new Map(); // download id -> {url, temp}
let limit = 2;
let idleTimer;

// Temp files from a previous session can't be in use any more.
const ready = clearTemp();
// Arm the idle timer even if no work ever arrives.
void ready.then(() => pump());

async function request(type, data = {}) {
  const response = await chrome.runtime.sendMessage({type, ...data});
  if (!response?.ok) throw new Error(response?.error || 'The extension stopped responding.');
  return response.data;
}

function pump() {
  clearTimeout(idleTimer);
  while (running.size < limit && queue.length) {
    const job = queue.shift();
    const controller = new AbortController();
    running.set(job.id, {attempt: job.attempt, controller});
    run(job, controller).finally(() => {
      if (running.get(job.id)?.controller === controller) running.delete(job.id);
      pump();
    });
  }
  if (!running.size && !queue.length && !saved.size) {
    // Ask the service worker to close this page after a quiet minute; if it
    // declines (something is still active), ask again later.
    idleTimer = setTimeout(async () => {
      const result = await request('IDLE').catch(() => null);
      if (!result?.closed) pump();
    }, 60_000);
  }
}

function progressReporter(update) {
  const started = performance.now();
  let lastSent = 0, speed = 0, lastBytes = 0, lastTime = started;
  return ({fraction, bytes, segments, total}) => {
    const now = performance.now();
    if (now - lastTime >= 500) {
      const instant = Math.max(0, (bytes - lastBytes) / ((now - lastTime) / 1000));
      speed = speed ? speed * 0.7 + instant * 0.3 : instant;
      lastBytes = bytes;
      lastTime = now;
    }
    if (now - lastSent < 400 && fraction < 1) return;
    lastSent = now;
    const elapsed = (now - started) / 1000;
    const eta = fraction > 0.02 ? Math.round(elapsed / fraction * (1 - fraction)) : null;
    void update({phase: 'downloading', progress: Math.min(97, fraction * 97), bytes, speed: Math.round(speed), eta,
      detail: `${segments} of ${total} parts`});
  };
}

async function openSink(name, estimate) {
  if (estimate && estimate * 1.1 > await freeSpace()) {
    throw new Error('Not enough free disk space for this video. Free some space or pick a lower quality.');
  }
  try { return await OpfsSink.create(name); } catch { return new MemorySink(); }
}

async function run(job, controller) {
  await ready;
  const {signal} = controller;
  const {id, attempt} = job;
  // Every update tells us whether the job is still wanted; if not, stop.
  const update = async patch => {
    const alive = await request('JOB_UPDATE', {id, attempt, patch}).catch(() => true);
    if (!alive) controller.abort(new DOMException('Cancelled', 'AbortError'));
  };
  const extension = job.format.audioOnly ? 'm4a' : 'mp4';
  // The public link only: an unlisted video's private hash stays out of the file.
  const metadata = job.metadata ? {title: job.video.title, artist: job.video.owner,
    comment: `https://vimeo.com/${job.video.id}`, tool: 'Vimeo Grab'} : {};
  let format = job.format;
  let refreshed = false;
  let sink;
  try {
    await update({phase: 'downloading', progress: 0, detail: 'Starting…'});
    signal.throwIfAborted();
    if (secondsUntilExpiry(format.url || format.audioUrl) < 120) {
      format = (await request('REFRESH', {id, attempt})).format;
      refreshed = true;
    }
    for (;;) {
      sink = await openSink(`${id}-${attempt}.${extension}`, format.size);
      try {
        await downloadHls(format, {sink, signal, metadata, onProgress: progressReporter(update)});
        break;
      } catch (error) {
        await sink.discard();
        sink = null;
        // Signed links expire after a while; fetch fresh ones once and start over.
        if (!error.expired || refreshed || signal.aborted) throw error;
        await update({detail: 'Refreshing expired links…'});
        format = (await request('REFRESH', {id, attempt})).format;
        refreshed = true;
      }
    }
    await update({phase: 'saving', progress: 98, detail: 'Finishing the file…'});
    signal.throwIfAborted();
    const file = await sink.close();
    const url = URL.createObjectURL(file);
    let downloadId;
    try {
      ({downloadId} = await request('SAVE', {id, attempt, url}));
    } catch (error) {
      URL.revokeObjectURL(url);
      await removeTemp(sink.name);
      throw error;
    }
    saved.set(downloadId, {url, temp: sink.name});
    sink = null; // Chrome is reading it now; release() deletes it when done.
    // A small file can finish before the RELEASE message would arrive.
    const {state} = await request('DOWNLOAD_STATE', {downloadId}).catch(() => ({state: 'in_progress'}));
    if (state !== 'in_progress') await release(downloadId);
  } catch (error) {
    if (sink) await sink.discard();
    const patch = signal.aborted ? {phase: 'cancelled', detail: ''} : {phase: 'error', detail: '', error: error.message};
    await request('JOB_UPDATE', {id, attempt, patch}).catch(() => {});
  }
}

async function release(downloadId) {
  const entry = saved.get(downloadId);
  if (!entry) return;
  saved.delete(downloadId);
  URL.revokeObjectURL(entry.url);
  if (entry.temp) await removeTemp(entry.temp);
  pump();
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Commands only come from the service worker.
  if (message?.target !== 'offscreen' || sender.id !== chrome.runtime.id || sender.url !== WORKER_URL) return false;
  let data = null;
  if (message.type === 'ENQUEUE') {
    limit = Math.min(3, Math.max(1, Number(message.concurrency) || limit));
    for (const job of message.jobs || []) {
      const current = running.get(job.id);
      if (current?.attempt === job.attempt || queue.some(item => item.id === job.id && item.attempt === job.attempt)) continue;
      // A retry replaces whatever is left of an older attempt.
      current?.controller.abort(new DOMException('Superseded', 'AbortError'));
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === job.id) queue.splice(i, 1);
      queue.push(job);
    }
    pump();
  } else if (message.type === 'CANCEL') {
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === message.id) queue.splice(i, 1);
    running.get(message.id)?.controller.abort(new DOMException('Cancelled', 'AbortError'));
    pump();
  } else if (message.type === 'RELEASE') {
    void release(message.downloadId);
  } else if (message.type === 'STATUS') {
    data = {ids: [...running.keys(), ...queue.map(job => job.id)]};
  } else return false;
  respond({ok: true, data});
  return false;
});
