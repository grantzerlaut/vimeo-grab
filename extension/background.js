// Service worker: scans pages, resolves Vimeo videos, and coordinates jobs.
// Stream assembly happens in the offscreen document (offscreen/offscreen.js);
// direct MP4 files go straight to Chrome's download manager.
import {vimeoRef, parseConfig, configsFromText, secondsUntilExpiry} from './lib/vimeo.mjs';
import {parseMaster, parseMedia, ProtectedError, UnsupportedError} from './lib/hls.mjs';
import {buildFormats, chooseFormat, sameRendition} from './lib/formats.mjs';
import {fetchResource, HttpError} from './lib/fetch.mjs';
import {buildFilename, siblingFilename, isoDate} from './lib/filename.mjs';
import {loadSettings} from './lib/settings.mjs';
import {vttToSrt} from './lib/subtitles.mjs';
import {clearTemp} from './lib/sink.mjs';
import {scanPage} from './lib/detector.mjs';

const ACTIVE = new Set(['preparing', 'queued', 'downloading', 'saving']);
const isActive = job => ACTIVE.has(job?.phase);
const MAX_VIDEOS = 60;
const MAX_PAGES = 10;
const MAX_FINISHED_JOBS = 100;
const RESOLVE_CONCURRENCY = 4;
const LOST_AFTER = 15_000;
const SOURCE_RANK = {manual: 0, player: 1, embed: 2, page: 3, data: 4, link: 5, script: 6, network: 7};
// Vimeo cookies (for private videos you can watch) are only sent for videos
// you named yourself: a pasted or right-clicked link, or the vimeo.com page
// you're on. Videos merely linked from a page are checked anonymously.
const COOKIE_SOURCES = new Set(['manual', 'page']);
const OFFSCREEN_URL = 'offscreen/offscreen.html';

// ------------------------------------------------------------------ state
// chrome.storage.session (memory only, cleared when the browser closes), one
// key per page ("page:<tabId>") and per job ("job:<id>") so a progress update
// rewrites one small record. All writes go through one queue, so every
// read-check-write below is atomic with respect to the others.

const pageKey = tabId => `page:${tabId}`;
const jobKey = id => `job:${id}`;
let writes = Promise.resolve();

function serial(fn) {
  const run = writes.then(fn);
  writes = run.catch(() => {});
  return run;
}

/** Every job, without reading the (much larger) page records. */
async function allJobs() {
  const keys = (await chrome.storage.session.getKeys()).filter(key => key.startsWith('job:'));
  return keys.length ? Object.values(await chrome.storage.session.get(keys)) : [];
}

const getJob = async id => (await chrome.storage.session.get(jobKey(id)))[jobKey(id)] || null;
const getPage = async tabId => (await chrome.storage.session.get(pageKey(tabId)))[pageKey(tabId)] || null;

/** Write records. Only ever called from inside serial(). */
async function save(items) {
  try {
    await chrome.storage.session.set(items);
  } catch {
    // Out of session quota: make room and try once more. (pruneNow, not
    // prune: we're already inside the queue, and waiting on it would deadlock.)
    await pruneNow({aggressive: true});
    await chrome.storage.session.set(items);
  }
}

/** Atomically update one job. `fn` returns the new job, or null to leave it alone. */
function updateJob(id, fn) {
  return serial(async () => {
    const job = await getJob(id);
    const next = job && fn(job);
    if (!next) return null;
    next.updatedAt = Date.now();
    await save({[jobKey(id)]: next});
    scheduleBadge();
    return next;
  });
}

/**
 * Patch a job that is still active (and, if given, still on this attempt).
 * Finished, cancelled or superseded jobs ignore late updates.
 */
function patchJob(id, patch, attempt) {
  return updateJob(id, job => {
    if (!isActive(job) || (attempt != null && job.attempt !== attempt)) return null;
    if (patch.phase === 'error') patch.seen = false;
    return Object.assign(job, patch);
  });
}

const putJobs = jobs => serial(async () => {
  await save(Object.fromEntries(jobs.map(job => [jobKey(job.id), {...job, updatedAt: Date.now()}])));
  scheduleBadge();
});

const putPage = page => serial(() => save({[pageKey(page.tabId)]: page}));

/** Atomically update a page, but only while it's still the same scan. */
const updatePage = (tabId, scanId, fn) => serial(async () => {
  const page = await getPage(tabId);
  if (page?.scanId !== scanId) return null;
  fn(page);
  await save({[pageKey(tabId)]: page});
  return page;
});

/** Keep storage small: the most recent pages and finished jobs only. */
async function pruneNow({aggressive = false} = {}) {
  const items = await chrome.storage.session.get(null);
  const pages = Object.entries(items).filter(([key]) => key.startsWith('page:'))
    .sort(([, a], [, b]) => b.scannedAt - a.scannedAt);
  const finished = Object.entries(items).filter(([key, job]) => key.startsWith('job:') && !isActive(job))
    .sort(([, a], [, b]) => b.createdAt - a.createdAt);
  const drop = [
    ...pages.slice(aggressive ? 1 : MAX_PAGES),
    ...finished.slice(aggressive ? 10 : MAX_FINISHED_JOBS),
  ].map(([key]) => key);
  if (drop.length) await chrome.storage.session.remove(drop);
}

const prune = options => serial(() => pruneNow(options));

let badgeTimer;
function scheduleBadge() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => void updateBadge(), 150);
}

async function updateBadge() {
  const jobs = await allJobs();
  const active = jobs.filter(isActive).length;
  const failed = jobs.some(job => job.phase === 'error' && !job.seen);
  await chrome.action.setBadgeText({text: active ? String(active) : failed ? '!' : ''}).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({color: active ? '#5b4bdb' : '#c2334d'}).catch(() => {});
}

// Work this service-worker instance is doing right now, counted per job
// attempt (or per scan). If Chrome stops the worker mid-way these are lost,
// which is how poll() tells a stuck job from a busy one.
const busyCounts = new Map();
const busyKey = job => `${job.id}:${job.attempt}`;
const hold = key => busyCounts.set(key, (busyCounts.get(key) || 0) + 1);
function release(key) {
  const count = (busyCounts.get(key) || 0) - 1;
  if (count > 0) busyCounts.set(key, count);
  else busyCounts.delete(key);
}

// ------------------------------------------------------------------ scanning

async function detect(tabId) {
  try {
    const results = await chrome.scripting.executeScript({target: {tabId, allFrames: true}, func: scanPage});
    return results.filter(item => item.result).map(item => ({...item.result, frameId: item.frameId}));
  } catch {
    // A frame mid-navigation can fail the whole call; the top frame alone still helps.
    const results = await chrome.scripting.executeScript({target: {tabId}, func: scanPage});
    return results.filter(item => item.result).map(item => ({...item.result, frameId: item.frameId}));
  }
}

/** Merge everything the frames reported into one candidate per video ID. */
function collectCandidates(frames) {
  const byId = new Map();
  const upsert = (ref, extra) => {
    const current = byId.get(ref.id);
    if (!current) {
      byId.set(ref.id, {...ref, title: extra.title || '', source: extra.source, configUrl: extra.configUrl,
        frameConfig: extra.frameConfig, order: byId.size});
      return;
    }
    if (!current.hash && ref.hash) Object.assign(current, {hash: ref.hash, playerUrl: ref.playerUrl, url: ref.url});
    if (!current.title && extra.title) current.title = extra.title;
    current.configUrl ||= extra.configUrl;
    current.frameConfig ||= extra.frameConfig;
    if (SOURCE_RANK[extra.source] < SOURCE_RANK[current.source]) current.source = extra.source;
  };
  for (const frame of frames) {
    const frameRef = vimeoRef(frame.url);
    for (const config of frame.configs || []) {
      const id = String(config?.video?.id || '');
      if (!/^\d{1,15}$/.test(id)) continue;
      const hash = (frameRef?.id === id && frameRef.hash) || config.video.unlisted_hash || '';
      const ref = vimeoRef(`https://player.vimeo.com/video/${id}${hash ? `?h=${hash}` : ''}`);
      if (ref) upsert(ref, {title: config.video.title, source: 'player', frameConfig: config});
    }
    for (const item of frame.items || []) {
      const ref = vimeoRef(item.url);
      if (!ref) continue;
      const configUrl = /^https:\/\/player\.vimeo\.com\/video\/\d+\/config\?/.test(item.url) ? item.url : undefined;
      // Only the tab's own vimeo.com page counts as "you're on it" (and gets
      // cookies); a vimeo.com page framed by another site is just an embed.
      const source = item.source === 'page' && !frame.top ? 'embed' : item.source;
      upsert(ref, {title: item.title, source, configUrl});
    }
  }
  return [...byId.values()].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.order - b.order);
}

const placeholder = candidate => ({
  id: candidate.id, hash: candidate.hash || '', url: candidate.url, playerUrl: candidate.playerUrl,
  configUrl: candidate.configUrl, refreshUrl: candidate.refreshUrl || null, source: candidate.source,
  title: candidate.title || `Vimeo video ${candidate.id}`, status: 'resolving', formats: [], textTracks: [],
});

const RESTRICTED = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/;

async function scan(tabId) {
  const tab = await chrome.tabs.get(tabId);
  let frames = [], notice = '', blocked = false;
  const url = tab.url || '';
  if (/^(https?|file):/.test(url) && !RESTRICTED.test(url)) {
    try { frames = await detect(tabId); } catch {
      blocked = true;
      notice = url.startsWith('file:')
        ? 'To scan files on your computer, turn on “Allow access to file URLs” for Vimeo Grab in chrome://extensions. You can still paste a link above.'
        : 'Vimeo Grab can’t read this page right now. Close and reopen it from the toolbar to scan again, or paste a link above.';
    }
  } else {
    blocked = true;
    notice = 'Chrome doesn’t let extensions read this page. You can still paste a Vimeo link above.';
  }
  const found = collectCandidates(frames);
  const previous = await getPage(tabId);
  // Links pasted by hand survive a rescan of the same page.
  const manual = (previous?.url === url ? previous.videos : [])
    .filter(video => video.source === 'manual' && !found.some(item => item.id === video.id));
  const candidates = [...manual, ...found].slice(0, MAX_VIDEOS);
  const total = found.length + manual.length;
  if (total > MAX_VIDEOS) notice = `Showing the first ${MAX_VIDEOS} of ${total} videos on this page.`;
  const page = {tabId, url, title: tab.title || '', scanId: crypto.randomUUID(), scannedAt: Date.now(), notice, blocked,
    videos: candidates.map(placeholder)};
  await putPage(page);
  void prune();
  void resolveAll(tabId, page.scanId, candidates);
  return page;
}

async function addLink(tabId, value) {
  const ref = vimeoRef(String(value || '').trim());
  if (!ref) throw new Error('That doesn’t look like a Vimeo video link.');
  const tab = await chrome.tabs.get(tabId);
  const candidate = {...ref, title: '', source: 'manual'};
  const page = await serial(async () => {
    let current = await getPage(tabId);
    if (!current || current.url !== tab.url) {
      current = {tabId, url: tab.url || '', title: tab.title || '', scanId: crypto.randomUUID(),
        scannedAt: Date.now(), notice: '', blocked: false, videos: []};
    }
    current.videos = [placeholder(candidate), ...current.videos.filter(video => video.id !== ref.id)];
    await save({[pageKey(tabId)]: current});
    return current;
  });
  void resolveAll(tabId, page.scanId, [candidate]);
  return {id: ref.id};
}

async function resolveAll(tabId, scanId, candidates) {
  hold(scanId);
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++];
      const video = await resolveVideo(candidate);
      await updatePage(tabId, scanId, page => {
        const index = page.videos.findIndex(item => item.id === candidate.id);
        if (index >= 0) page.videos[index] = video;
      });
    }
  };
  try {
    await Promise.all(Array.from({length: Math.min(RESOLVE_CONCURRENCY, candidates.length)}, worker));
  } finally { release(scanId); }
}

// ------------------------------------------------------------------ resolving

async function fetchJson(url, cookies) {
  const {text} = await fetchResource(url, {retries: 1, cookies});
  try { return JSON.parse(text); } catch { throw new Error('Vimeo sent an unexpected response. Try again in a moment.'); }
}

/** The config endpoint, then the player page itself. */
async function fetchConfig(candidate, cookies) {
  const configUrl = new URL(candidate.playerUrl);
  configUrl.pathname += '/config';
  try {
    const config = await fetchJson(configUrl.href, cookies);
    if (config?.video?.id) return config;
  } catch (error) {
    if (!(error instanceof HttpError) || error.status === 404) throw error;
  }
  try {
    const {text} = await fetchResource(candidate.playerUrl, {retries: 1, cookies});
    const config = configsFromText(text).find(item => String(item.video?.id) === candidate.id);
    if (config) return config;
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) {
      throw new Error('This video only plays on the site it’s embedded in. Open that page and let the player load (press play if needed), then rescan.', {cause: error});
    }
    throw error;
  }
  throw new Error('Vimeo didn’t share this video’s details. Play it on the page, then rescan.');
}

/**
 * Renew an embed's links with the signed refresh URL Vimeo gave its player.
 * No cookies or Referer: it's the same request the player makes when its links expire.
 */
async function refreshConfig(video, url) {
  const request = await fetchJson(url, false);
  if (!request?.files) throw new Error('Vimeo couldn’t renew this video’s links. Reload the page and rescan.');
  return {video, request};
}

const soonestExpiry = info => Math.min(Infinity,
  ...[...info.masters, ...info.progressive.map(item => item.url)].map(url => secondsUntilExpiry(url)));

/** Ways to get a usable player config for a candidate, freshest-first. */
function configSources(candidate) {
  const cookies = COOKIE_SOURCES.has(candidate.source);
  const sources = [];
  const frame = candidate.frameConfig;
  if (frame) {
    const info = parseConfig(frame, candidate);
    // The config in a player's page is only as fresh as the page itself.
    sources.frameFresh = soonestExpiry(info) > 300;
    if (sources.frameFresh) sources.push(async () => frame);
    if (info.refreshUrl) sources.push(() => refreshConfig(frame.video, info.refreshUrl));
  }
  if (candidate.refreshUrl) {
    sources.push(() => refreshConfig({id: candidate.id, title: candidate.title, owner: {name: candidate.owner}},
      candidate.refreshUrl));
  }
  if (candidate.configUrl) sources.push(() => fetchJson(candidate.configUrl, cookies));
  sources.push(() => fetchConfig(candidate, cookies));
  return sources;
}

/** Fetch one media playlist so DRM-only videos are flagged before anyone clicks. */
async function assertDownloadable(master) {
  const probe = [...master.variants].sort((a, b) => a.bandwidth - b.bandwidth)[0];
  try {
    const response = await fetchResource(probe.url, {retries: 1});
    parseMedia(response.text, response.url);
  } catch (error) {
    // A flaky probe shouldn't hide a good video; the download checks again anyway.
    if (error instanceof ProtectedError || error instanceof UnsupportedError || error.expired) throw error;
  }
}

function describe(error) {
  if (!error) return 'Something went wrong. Try again.';
  if (error instanceof ProtectedError || error instanceof UnsupportedError || error instanceof HttpError) return error.message;
  if (error.name === 'TypeError' && /fetch|network/i.test(error.message)) {
    return 'Couldn’t reach Vimeo. Check your connection and try again.';
  }
  if (error.name === 'AbortError') return 'Cancelled.';
  return error.message || 'Something went wrong. Try again.';
}

async function videoFromConfig(base, candidate, config) {
  const info = parseConfig(config, candidate);
  const video = {...base, hash: info.hash || base.hash, title: info.title, owner: info.owner, duration: info.duration,
    width: info.width, height: info.height, thumbnail: info.thumbnail, textTracks: info.textTracks,
    refreshUrl: info.refreshUrl || base.refreshUrl, status: 'ready'};
  if (video.hash !== base.hash) Object.assign(video, vimeoRef(`https://player.vimeo.com/video/${video.id}?h=${video.hash}`));
  if (info.live) return {...video, status: 'unsupported', error: 'Live streams can’t be saved. Try again once the recording is published.'};
  let master = null, lastError = null;
  for (const url of info.masters) {
    try {
      const response = await fetchResource(url, {retries: 1});
      master = parseMaster(response.text, response.url);
      if (master.variants.length) break;
      master = null;
    } catch (error) { lastError = error; }
  }
  if (!master && lastError?.expired) throw lastError;
  if (master) await assertDownloadable(master);
  video.formats = buildFormats({progressive: info.progressive, master, duration: info.duration});
  if (!video.formats.length) {
    if (info.protected) throw new ProtectedError();
    throw lastError || new UnsupportedError('Vimeo didn’t offer a downloadable version of this video.');
  }
  return video;
}

async function resolveVideo(candidate) {
  const base = placeholder(candidate);
  let lastError = null;
  const sources = configSources(candidate);
  // The player's own config was too old to use; if nothing fresher works, the
  // fix is a page reload (the player's inline config never changes by itself).
  const staleFrame = Boolean(candidate.frameConfig) && !sources.frameFresh;
  for (const source of sources) {
    let config;
    try { config = await source(); } catch (error) { lastError = error; continue; }
    if (!config?.video?.id && !config?.request) continue;
    try {
      return await videoFromConfig(base, candidate, config);
    } catch (error) {
      lastError = error;
      // Expired links: try a fresher config. Anything else is final.
      if (!error.expired) break;
    }
  }
  if (staleFrame && !(lastError instanceof ProtectedError)) {
    lastError = new Error('This video’s links on the page have expired. Reload the page, then scan again.', {cause: lastError});
  }
  return {...base, status: lastError instanceof ProtectedError ? 'protected' : 'error',
    error: describe(lastError || new Error('Vimeo didn’t share this video’s details. Play it on the page, then rescan.'))};
}

async function refreshFormat(job, preference) {
  const video = await resolveVideo({...job.video, configUrl: undefined});
  if (video.status !== 'ready') throw new Error(video.error);
  const format = (job.format?.id && video.formats.find(item => sameRendition(item, job.format))) ||
    chooseFormat(video.formats, preference || (job.format?.audioOnly ? 'audio' : String(job.format?.height || 'best')));
  if (!format) throw new Error('That quality is no longer available. Rescan and pick another.');
  return {format, video};
}

// ------------------------------------------------------------------ jobs

function pickTracks(tracks, mode) {
  if (mode === 'all') return tracks;
  if (mode !== 'default' || !tracks.length) return [];
  const language = chrome.i18n.getUILanguage().split('-')[0];
  return [tracks.find(track => track.default) || tracks.find(track => track.lang.split('-')[0] === language) || tracks[0]];
}

function filenameFor(video, format, settings, pageUrl) {
  let site = '';
  try { site = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { /* Not a web page. */ }
  return buildFilename({
    template: settings.template, folder: settings.folder, extension: format.audioOnly ? 'm4a' : 'mp4',
    values: {title: video.title, id: video.id, quality: format.audioOnly ? 'audio' : format.label,
      owner: video.owner, date: isoDate(), site},
  });
}

const jobVideo = video => ({
  id: video.id, hash: video.hash || '', title: video.title, owner: video.owner || '', duration: video.duration || 0,
  thumbnail: video.thumbnail || null, url: video.url, playerUrl: video.playerUrl, refreshUrl: video.refreshUrl || null,
  source: video.source || 'manual',
});

function newJob({video, format, settings, pageUrl, tabId, id = crypto.randomUUID(), createdAt = Date.now(), attempt = 1}) {
  return {
    id, attempt, createdAt, tabId, pageUrl, video: jobVideo(video),
    format, filename: filenameFor(video, format, settings, pageUrl), saveAs: settings.saveAs, metadata: settings.metadata,
    subtitleFormat: settings.subtitleFormat,
    subtitles: pickTracks(video.textTracks || [], settings.subtitles).map(({lang, label, kind, url}) => ({lang, label, kind, url})),
    phase: 'queued', progress: 0, bytes: 0, size: format.size || 0, error: '', detail: '', note: '', seen: true,
  };
}

const noFormatMessage = (video, preference) => preference === 'audio'
  ? `“${video.title}” has no separate audio track to save.`
  : `Vimeo didn’t offer a downloadable version of “${video.title}”.`;

async function createJobs({tabId, items = [], quality}) {
  const settings = await loadSettings();
  const page = await getPage(tabId);
  if (!page) throw new Error('This page has changed. Scan it again.');
  const preference = quality || settings.quality;
  const active = (await allJobs()).filter(isActive);
  const jobs = [], problems = [];
  for (const {id, formatId} of items) {
    const video = page.videos.find(item => item.id === id && item.status === 'ready');
    if (!video) continue;
    const format = video.formats.find(item => item.id === formatId) || chooseFormat(video.formats, preference);
    if (!format) { problems.push(noFormatMessage(video, preference)); continue; }
    if ([...active, ...jobs].some(job => job.video.id === video.id && job.format?.id === format.id)) {
      problems.push(`“${video.title}” is already downloading.`);
      continue;
    }
    jobs.push(newJob({video, format, settings, pageUrl: page.url, tabId}));
  }
  if (!jobs.length) throw new Error(problems[0] || 'Select at least one video.');
  await putJobs(jobs);
  void prune();
  await startJobs(jobs, settings);
  return {count: jobs.length, skipped: problems.length};
}

/** Start queued jobs: streams go to the offscreen page first, then direct files. */
async function startJobs(jobs, settings) {
  // Every job in the batch counts as busy until its own start finishes, so a
  // long batch can't look "lost" to poll() while it waits its turn.
  const pending = new Set(jobs.map(busyKey));
  for (const key of pending) hold(key);
  const done = job => {
    if (pending.delete(busyKey(job))) release(busyKey(job));
  };
  try {
    const streamed = jobs.filter(job => job.format.kind !== 'mp4');
    if (streamed.length) {
      try {
        await toOffscreen(async () => {
          // Re-check inside the lock: anything cancelled meanwhile must not start.
          const live = (await Promise.all(streamed.map(job => getJob(job.id))))
            .filter(job => job?.phase === 'queued');
          return live.length ? {type: 'ENQUEUE', jobs: live, concurrency: settings.concurrency} : null;
        });
      } catch {
        for (const job of streamed) await patchJob(job.id, {phase: 'error', error: 'Couldn’t start the downloader. Try again.'}, job.attempt);
      } finally {
        streamed.forEach(done);
      }
    }
    for (const job of jobs.filter(item => item.format.kind === 'mp4')) {
      try { await startDirect(job, settings); } finally { done(job); }
    }
  } finally {
    // Whatever went wrong above, nothing stays marked busy forever.
    jobs.forEach(done);
  }
}

async function startDirect(job, settings) {
  try {
    if ((await getJob(job.id))?.phase !== 'queued') return;
    let format = job.format;
    if (secondsUntilExpiry(format.url) < 120) {
      format = (await refreshFormat(job)).format;
      // The direct file may be gone after a refresh; then it's a stream job now.
      if (format.kind !== 'mp4') {
        const next = await patchJob(job.id, {format, size: format.size || 0}, job.attempt);
        if (next) await startJobs([next], settings);
        return;
      }
    }
    const downloadId = await download({url: format.url, filename: job.filename, saveAs: job.saveAs});
    const started = await patchJob(job.id, {downloadId, format, phase: 'downloading'}, job.attempt);
    if (!started) {
      await chrome.downloads.cancel(downloadId).catch(() => {});
      return;
    }
    await settleIfDone(downloadId);
  } catch (error) {
    await patchJob(job.id, {phase: 'error', error: describe(error), detail: ''}, job.attempt);
  }
}

/** chrome.downloads.download, retrying with a plain name if Chrome rejects ours. */
async function download({url, filename, saveAs}) {
  try {
    return await chrome.downloads.download({url, filename, saveAs, conflictAction: 'uniquify'});
  } catch (error) {
    if (!/filename/i.test(error.message)) throw error;
    const plain = filename.replace(/[^/]+(\.\w+)$/, (_, extension) => `Vimeo video ${Date.now()}${extension}`);
    return chrome.downloads.download({url, filename: plain, saveAs, conflictAction: 'uniquify'});
  }
}

async function cancelJob(id) {
  const job = await updateJob(id, current => (isActive(current) ? Object.assign(current, {phase: 'cancelled', detail: '', error: ''}) : null));
  if (!job) return;
  if (job.downloadId != null) await chrome.downloads.cancel(job.downloadId).catch(() => {});
  await toOffscreen({type: 'CANCEL', id}, {create: false}).catch(() => {});
}

async function retryJob(id) {
  const settings = await loadSettings();
  const job = await updateJob(id, current => (isActive(current) ? null : Object.assign(current, {
    phase: 'preparing', attempt: (current.attempt || 1) + 1, progress: 0, bytes: 0, speed: 0, eta: null,
    error: '', note: '', detail: 'Refreshing links…', downloadId: null, seen: true,
  })));
  if (!job) return;
  hold(busyKey(job));
  try {
    // A job that failed before it had a format (right-click) uses the default quality.
    const {format, video} = await refreshFormat(job, job.format?.id ? undefined : settings.quality);
    const filename = job.filename && job.format?.id === format.id ? job.filename : filenameFor(video, format, settings, job.pageUrl);
    const next = await updateJob(id, current => (current.phase === 'preparing' && current.attempt === job.attempt
      ? Object.assign(current, {format, filename, video: jobVideo({...current.video, ...video}), phase: 'queued', detail: '',
        size: format.size || 0, saveAs: settings.saveAs})
      : null));
    if (next) await startJobs([next], settings);
  } catch (error) {
    await patchJob(id, {phase: 'error', error: describe(error), detail: ''}, job.attempt);
  } finally { release(busyKey(job)); }
}

/** Download from a link, frame or Vimeo page via the right-click menu. */
async function quickDownload(info, tab) {
  const url = info.linkUrl || info.frameUrl || info.pageUrl;
  const ref = vimeoRef(url);
  const id = crypto.randomUUID();
  const job = {id, attempt: 1, createdAt: Date.now(), tabId: tab?.id ?? -1, pageUrl: tab?.url || '', phase: 'preparing',
    progress: 0, detail: 'Finding the video…', error: '', note: '', filename: '', format: {}, seen: true,
    video: {id: ref?.id || '', title: ref ? `Vimeo video ${ref.id}` : 'Vimeo link', url: ref?.url || url,
      playerUrl: ref?.playerUrl || '', hash: ref?.hash || '', source: 'manual'}};
  if (!ref) {
    await putJobs([{...job, phase: 'error', seen: false, detail: '', retryable: false,
      error: 'That link isn’t a single Vimeo video (it may be a showcase, channel or profile).'}]);
    return;
  }
  // Already downloading: the existing entry in Downloads shows its progress.
  if ((await allJobs()).some(item => isActive(item) && item.video?.id === ref.id)) return;
  await putJobs([job]);
  hold(busyKey(job));
  try {
    const settings = await loadSettings();
    let frameConfig;
    if (info.frameId && tab?.id != null) {
      const [result] = await chrome.scripting.executeScript({target: {tabId: tab.id, frameIds: [info.frameId]}, func: scanPage})
        .catch(() => []);
      frameConfig = result?.result?.configs?.find(config => String(config.video?.id) === ref.id);
    }
    const source = frameConfig ? 'player' : info.linkUrl ? 'manual' : 'page';
    const video = await resolveVideo({...ref, source, frameConfig});
    if (video.status !== 'ready') throw new Error(video.error);
    const format = chooseFormat(video.formats, settings.quality);
    if (!format) throw new Error(noFormatMessage(video, settings.quality));
    const full = newJob({video, format, settings, pageUrl: tab?.url || url, tabId: tab?.id ?? -1, id, createdAt: job.createdAt});
    const next = await updateJob(id, current => (current.phase === 'preparing' ? full : null));
    if (next) await startJobs([next], settings);
  } catch (error) {
    await patchJob(id, {phase: 'error', error: describe(error), detail: ''});
  } finally { release(busyKey(job)); }
}

// ------------------------------------------------------------------ finishing

function toDataUrl(text, type) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};charset=utf-8;base64,${btoa(binary)}`;
}

async function saveSubtitles(job) {
  if (!job.subtitles?.length) return;
  // Name them after the file Chrome actually saved (it may have added " (1)").
  const folder = job.filename.includes('/') ? job.filename.slice(0, job.filename.lastIndexOf('/') + 1) : '';
  const saved = job.savedAs || '';
  const base = folder + (saved || job.filename.split('/').pop());
  const srt = job.subtitleFormat === 'srt';
  let fresh = null, failed = 0;
  for (const track of job.subtitles) {
    try {
      let text;
      try {
        text = (await fetchResource(track.url, {retries: 1})).text;
      } catch (error) {
        if (!error.expired) throw error;
        fresh ||= (await refreshFormat(job)).video.textTracks;
        const match = fresh.find(item => item.lang === track.lang && item.kind === track.kind);
        if (!match) throw error;
        text = (await fetchResource(match.url, {retries: 1})).text;
      }
      if (!text.slice(0, 20).includes('WEBVTT')) throw new Error('Not a subtitle file.');
      const url = toDataUrl(srt ? vttToSrt(text) : text, srt ? 'application/x-subrip' : 'text/vtt');
      if (url.length > 2_000_000) throw new Error('Subtitle file too large.');
      const suffix = `.${track.lang}${track.kind === 'captions' ? '.cc' : ''}.${srt ? 'srt' : 'vtt'}`;
      await download({url, filename: siblingFilename(base, suffix), saveAs: job.saveAs});
    } catch { failed++; }
  }
  if (failed) {
    const note = failed === job.subtitles.length ? 'Subtitles couldn’t be saved.' : 'Some subtitles couldn’t be saved.';
    await updateJob(job.id, current => Object.assign(current, {note}));
  }
}

/** Finish (or fail) the job a download belongs to. Safe to call more than once. */
async function onDownloadChanged(delta) {
  if (!delta.state || delta.state.current === 'in_progress') return;
  const [item] = await chrome.downloads.search({id: delta.id});
  const complete = delta.state.current === 'complete';
  const reason = delta.error?.current || item?.error || 'unknown';
  // Look up and patch in one step, after any pending write of this downloadId.
  const job = await serial(async () => {
    const found = (await allJobs()).find(current => current.downloadId === delta.id && isActive(current));
    if (!found) return null;
    Object.assign(found, complete
      // Only the file's name: the full path would include the OS user name.
      ? {phase: 'complete', progress: 100, detail: '', finishedAt: Date.now(), savedAs: (item?.filename || '').split(/[\\/]/).pop(),
        bytes: item?.fileSize || item?.bytesReceived || found.bytes}
      : reason === 'USER_CANCELED'
        ? {phase: 'cancelled', detail: ''}
        : {phase: 'error', seen: false, detail: '', error: `Chrome couldn’t save the file (${reason.toLowerCase().replace(/_/g, ' ')}).`},
      {updatedAt: Date.now()});
    await save({[jobKey(found.id)]: found});
    scheduleBadge();
    return found;
  });
  if (job?.phase === 'complete') void saveSubtitles(job);
  // Let the offscreen page free the assembled file.
  void toOffscreen({type: 'RELEASE', downloadId: delta.id}, {create: false}).catch(() => {});
}

/** A download can finish before we've recorded its id; catch that case. */
async function settleIfDone(downloadId) {
  const [item] = await chrome.downloads.search({id: downloadId});
  if (item && item.state !== 'in_progress') {
    await onDownloadChanged({id: downloadId, state: {current: item.state}, error: item.error ? {current: item.error} : undefined});
  }
}

/** Progress the downloads API doesn't push, plus jobs lost to a crash or a stopped worker. */
async function poll() {
  const jobs = await allJobs();
  for (const job of jobs.filter(item => isActive(item) && item.downloadId != null)) {
    const [item] = await chrome.downloads.search({id: job.downloadId});
    if (!item) await patchJob(job.id, {phase: 'error', error: 'The file was removed from Chrome’s download list.'});
    else if (item.state !== 'in_progress') await settleIfDone(item.id);
    else if (job.format?.kind === 'mp4') {
      await patchJob(job.id, {bytes: item.bytesReceived, size: item.totalBytes || job.size,
        progress: item.totalBytes ? item.bytesReceived / item.totalBytes * 100 : job.progress});
    }
  }
  const status = await toOffscreen({type: 'STATUS'}, {create: false}).catch(() => null);
  const known = new Set(status?.ids || []);
  for (const job of jobs.filter(isActive)) {
    if (busyCounts.has(busyKey(job)) || job.downloadId != null || Date.now() - (job.updatedAt || 0) < LOST_AFTER) continue;
    const lost = job.phase === 'preparing' || job.format?.kind === 'mp4' || !known.has(job.id);
    if (!lost) continue;
    // Compare-and-set against the snapshot: if the job moved on while we were
    // looking (or is busy now), it isn't lost.
    await updateJob(job.id, current => (isActive(current) && current.attempt === job.attempt &&
      current.updatedAt === job.updatedAt && !busyCounts.has(busyKey(current))
      ? Object.assign(current, {phase: 'error', seen: false, detail: '',
        error: 'The download stopped unexpectedly. Retry to start it again.'})
      : null));
  }
}

// ------------------------------------------------------------------ offscreen

let offscreenLock = Promise.resolve();
function withOffscreenLock(fn) {
  const run = offscreenLock.then(fn);
  offscreenLock = run.catch(() => {});
  return run;
}

const hasOffscreen = async () =>
  (await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']})).length > 0;

/**
 * Send a message to the offscreen page, creating it if needed. `message` may
 * be a function, evaluated inside the lock, returning the message or null.
 */
function toOffscreen(message, {create = true} = {}) {
  return withOffscreenLock(async () => {
    // Decide what to send first, so a page is never created with nothing to do.
    const body = typeof message === 'function' ? await message() : message;
    if (!body) return null;
    if (!await hasOffscreen()) {
      if (!create) return null;
      await chrome.offscreen.createDocument({url: OFFSCREEN_URL, reasons: ['BLOBS'],
        justification: 'Assemble downloaded Vimeo video segments into a single MP4 file.'});
    }
    // The page may still be registering its listener right after creation.
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await chrome.runtime.sendMessage({...body, target: 'offscreen'});
        return response?.data ?? null;
      } catch (error) {
        if (attempt >= 20) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  });
}

function closeOffscreenIfIdle() {
  return withOffscreenLock(async () => {
    if ((await allJobs()).some(job => isActive(job) && job.format?.kind !== 'mp4')) return {closed: false};
    if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
    return {closed: true};
  });
}

// ------------------------------------------------------------------ messages

const POPUP_ACTIONS = {
  SCAN: message => scan(message.tabId),
  ADD_LINK: message => addLink(message.tabId, message.url),
  DOWNLOAD: message => createJobs(message),
  CANCEL: message => cancelJob(message.id),
  RETRY: message => retryJob(message.id),
  REMOVE: async message => {
    await cancelJob(message.id);
    await serial(() => chrome.storage.session.remove(jobKey(message.id)));
    scheduleBadge();
  },
  CLEAR_FINISHED: () => serial(async () => {
    await chrome.storage.session.remove((await allJobs()).filter(job => !isActive(job)).map(job => jobKey(job.id)));
    scheduleBadge();
  }),
  MARK_SEEN: () => serial(async () => {
    const unseen = (await allJobs()).filter(job => !isActive(job) && !job.seen);
    if (unseen.length) await save(Object.fromEntries(unseen.map(job => [jobKey(job.id), {...job, seen: true}])));
    scheduleBadge();
  }),
  SHOW: async message => {
    const job = await getJob(message.id);
    if (job?.downloadId != null) chrome.downloads.show(job.downloadId);
  },
  POLL: () => poll(),
};

const OFFSCREEN_ACTIONS = {
  // Returns whether the job is still wanted, so a cancelled run stops.
  JOB_UPDATE: async message => Boolean(await patchJob(message.id, message.patch, message.attempt)),
  SAVE: async message => {
    const job = await getJob(message.id);
    if (!isActive(job) || job.attempt !== message.attempt) throw new Error('The download was cancelled.');
    if (!/^blob:chrome-extension:\/\//.test(message.url)) throw new Error('Unexpected file address.');
    const downloadId = await download({url: message.url, filename: job.filename, saveAs: job.saveAs});
    const saving = await patchJob(job.id, {downloadId, phase: 'saving', progress: 99, detail: 'Saving…'}, message.attempt);
    if (!saving) {
      await chrome.downloads.cancel(downloadId).catch(() => {});
      throw new Error('The download was cancelled.');
    }
    void settleIfDone(downloadId);
    return {downloadId};
  },
  REFRESH: async message => {
    const job = await getJob(message.id);
    if (!isActive(job) || job.attempt !== message.attempt) throw new Error('The download was cancelled.');
    const {format, video} = await refreshFormat(job);
    // Keep the newest refresh URL so a later refresh can chain from it.
    await patchJob(job.id, {format, video: jobVideo({...job.video, ...video})}, message.attempt);
    return {format};
  },
  DOWNLOAD_STATE: async message => ({state: (await chrome.downloads.search({id: message.downloadId}))[0]?.state || 'missing'}),
  IDLE: () => closeOffscreenIfIdle(),
};

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Only the extension's own pages may send commands. There are no content
  // scripts, and web pages can't reach this listener (no externally_connectable).
  if (message?.target === 'offscreen' || sender.id !== chrome.runtime.id) return false;
  if (!sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  const fromOffscreen = sender.url === chrome.runtime.getURL(OFFSCREEN_URL);
  const handler = (fromOffscreen ? OFFSCREEN_ACTIONS : POPUP_ACTIONS)[message?.type];
  if (!handler) return false;
  Promise.resolve(handler(message)).then(
    data => respond({ok: true, data}),
    error => respond({ok: false, error: describe(error)}));
  return true;
});

// ------------------------------------------------------------------ events

chrome.downloads.onChanged.addListener(delta => { void onDownloadChanged(delta); });

chrome.tabs.onRemoved.addListener(tabId => {
  void serial(() => chrome.storage.session.remove(pageKey(tabId)));
});

// Without the "tabs" permission Chrome doesn't say where a tab went, so any
// navigation simply forgets that tab's scan.
chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (changes.status !== 'loading' && !changes.url) return;
  void (async () => {
    if (!await getPage(tabId)) return; // Never scanned: nothing to forget.
    await serial(() => chrome.storage.session.remove(pageKey(tabId)));
  })();
});

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({id: 'link', title: 'Download Vimeo video', contexts: ['link'],
      targetUrlPatterns: ['*://vimeo.com/*', '*://*.vimeo.com/*']});
    chrome.contextMenus.create({id: 'frame', title: 'Download this Vimeo video', contexts: ['frame'],
      documentUrlPatterns: ['https://player.vimeo.com/video/*']});
    chrome.contextMenus.create({id: 'page', title: 'Download this Vimeo video', contexts: ['page'],
      documentUrlPatterns: ['https://vimeo.com/*', 'https://www.vimeo.com/*']});
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => { void quickDownload(info, tab); });

chrome.runtime.onInstalled.addListener(details => {
  createMenus();
  if (details.reason === 'install') chrome.runtime.openOptionsPage().catch(() => {});
});

// A browser restart leaves no downloads running, but may leave a half-written
// temp file behind; clear it rather than wait for the next stream download.
chrome.runtime.onStartup.addListener(() => {
  void withOffscreenLock(async () => { if (!await hasOffscreen()) await clearTemp(); });
});

scheduleBadge();
