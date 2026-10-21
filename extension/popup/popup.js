import {QUALITIES, loadSettings} from '../lib/settings.mjs';

const $ = (selector, root = document) => root.querySelector(selector);
const ACTIVE = new Set(['preparing', 'queued', 'downloading', 'saving']);
const isActive = job => ACTIVE.has(job?.phase);
const AUTO_SELECT = new Set(['manual', 'player', 'embed', 'page']);
const SOURCE_LABEL = {link: 'Linked', script: 'In page data', network: 'Loaded by page', data: 'In page data'};

const state = {
  tabId: null,
  tab: null,
  page: null,
  stale: false, // The tab navigated away from the scanned page.
  jobs: {},
  settings: null,
  selected: new Set(),
  seenReady: new Set(),
  choices: new Map(), // video id -> format id
  scanning: false,
  view: 'videos',
};
const pageKey = () => `page:${state.tabId}`;

// ------------------------------------------------------------------ helpers

async function send(type, data = {}) {
  const response = await chrome.runtime.sendMessage({type, ...data});
  if (!response?.ok) throw new Error(response?.error || 'The extension didn’t respond. Close this and try again.');
  return response.data;
}

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(bytes >= 1e8 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const s = Math.round(seconds);
  const hours = Math.floor(s / 3600), minutes = Math.floor(s / 60) % 60, rest = String(s % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

let noticeTimer;
function notify(text, {error = false, sticky = false} = {}) {
  clearTimeout(noticeTimer);
  const notice = $('#notice');
  notice.textContent = text;
  notice.classList.toggle('error', error);
  notice.hidden = !text;
  if (text && !sticky) noticeTimer = setTimeout(showPageNotice, error ? 7000 : 3500);
}

function showPageNotice() {
  const text = state.page?.notice || '';
  notify(text, {sticky: true, error: Boolean(state.page?.blocked)});
}

function announce(text) {
  $('#announcer').textContent = text;
}

const latestJob = videoId => Object.values(state.jobs)
  .filter(job => job.video?.id === videoId)
  .sort((a, b) => b.createdAt - a.createdAt)[0];

const jobFor = videoId => {
  const job = latestJob(videoId);
  // Only show a finished job on a card while it's recent; history lives in Downloads.
  return job && (isActive(job) || Date.now() - (job.updatedAt || job.createdAt) < 30 * 60_000) ? job : null;
};

// ------------------------------------------------------------------ status lines

function describeJob(job) {
  const size = formatBytes(job.size);
  switch (job.phase) {
    case 'preparing': return job.detail || 'Getting ready…';
    case 'queued': return 'Waiting for a free slot…';
    case 'downloading': {
      const parts = [`${Math.floor(job.progress || 0)}%`];
      if (job.bytes) parts.push(size && job.format?.kind === 'mp4' ? `${formatBytes(job.bytes)} of ${size}` : formatBytes(job.bytes));
      if (job.speed > 0) parts.push(`${formatBytes(job.speed)}/s`);
      if (job.eta) parts.push(`${formatTime(job.eta)} left`);
      return parts.join(' · ');
    }
    case 'saving': return job.detail || 'Saving…';
    case 'complete': return `Saved${job.bytes ? ` · ${formatBytes(job.bytes)}` : ''}${job.note ? ` · ${job.note}` : ''}`;
    case 'cancelled': return 'Cancelled';
    default: return job.error || 'Download failed.';
  }
}

function renderStatus(container, job) {
  container.hidden = !job;
  if (!job) return;
  container.classList.toggle('error', job.phase === 'error');
  container.classList.toggle('complete', job.phase === 'complete');
  $('.status-text', container).textContent = describeJob(job);
  $('.cancel', container).hidden = !isActive(job);
  $('.retry', container).hidden = !['error', 'cancelled'].includes(job.phase) || job.retryable === false;
  $('.show', container).hidden = job.phase !== 'complete' || job.downloadId == null;
  const bar = $('progress', container);
  bar.hidden = !isActive(job);
  if (job.phase === 'downloading' && job.progress > 0) bar.value = job.progress;
  else bar.removeAttribute('value');
}

function wireStatus(container, getJob) {
  const act = async (type, button) => {
    const job = getJob();
    if (!job) return;
    button.disabled = true;
    try { await send(type, {id: job.id}); } catch (error) { notify(error.message, {error: true}); }
    finally { button.disabled = false; }
  };
  $('.cancel', container).addEventListener('click', event => act('CANCEL', event.currentTarget));
  $('.retry', container).addEventListener('click', event => act('RETRY', event.currentTarget));
  $('.show', container).addEventListener('click', event => act('SHOW', event.currentTarget));
}

// ------------------------------------------------------------------ videos

const videoById = id => state.page?.videos.find(video => video.id === id);
const downloadable = video => video?.status === 'ready' && !isActive(jobFor(video.id));

function createVideoCard(id) {
  const card = $('#video-template').content.firstElementChild.cloneNode(true);
  card.dataset.id = id;
  const box = $('.pick-box', card);
  box.addEventListener('change', () => {
    if (box.checked) state.selected.add(id); else state.selected.delete(id);
    renderSelection();
  });
  $('.format', card).addEventListener('change', event => {
    if (event.target.value) state.choices.set(id, event.target.value);
    else state.choices.delete(id);
  });
  $('.open', card).addEventListener('click', () => chrome.tabs.create({url: videoById(id)?.url}));
  $('.copy', card).addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(videoById(id)?.url || '');
      notify('Link copied.');
    } catch { notify('Couldn’t copy the link.', {error: true}); }
  });
  $('.save', card).addEventListener('click', () => startDownloads([id]));
  $('img', card).addEventListener('error', event => event.target.removeAttribute('src'));
  wireStatus($('.status', card), () => latestJob(id));
  return card;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function videoMeta(video) {
  const meta = [];
  if (video.status === 'resolving') return document.createTextNode('Checking…');
  const fragment = document.createDocumentFragment();
  if (video.status === 'protected') {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.append(icon('lock'), 'DRM-protected');
    fragment.append(tag, ' ');
  }
  if (video.owner) meta.push(video.owner);
  if (SOURCE_LABEL[video.source]) meta.push(SOURCE_LABEL[video.source]);
  if (video.status === 'ready' && video.formats[0] && !video.formats[0].audioOnly) meta.push(`up to ${video.formats[0].label}`);
  fragment.append(meta.join(' · '));
  return fragment;
}

function updateVideoCard(card, video) {
  const ready = video.status === 'ready';
  card.classList.toggle('resolving', video.status === 'resolving');
  card.classList.toggle('unavailable', !ready && video.status !== 'resolving');
  const title = $('.title', card);
  title.textContent = video.title;
  title.title = video.title;
  $('.meta', card).replaceChildren(videoMeta(video));
  $('.pick-label', card).textContent = `Select ${video.title}`;
  const image = $('img', card);
  if (video.thumbnail && image.dataset.src !== video.thumbnail) {
    image.dataset.src = video.thumbnail;
    image.src = video.thumbnail;
  }
  $('.duration', card).textContent = formatTime(video.duration);

  const select = $('.format', card);
  const signature = video.formats.map(format => `${format.id}:${format.size}`).join('|');
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    // A choice from an earlier scan may no longer exist; forget it rather than guess.
    if (!video.formats.some(format => format.id === state.choices.get(video.id))) state.choices.delete(video.id);
    const choice = state.choices.get(video.id) || '';
    select.replaceChildren(new Option(ready ? 'Default quality' : '—', ''));
    for (const format of video.formats) {
      const size = formatBytes(format.size);
      const name = format.audioOnly ? 'Audio only (M4A)' : format.label;
      select.append(new Option(size ? `${name} · ~${size}` : name, format.id));
    }
    select.value = video.formats.some(format => format.id === choice) ? choice : '';
  }

  const job = jobFor(video.id);
  const busy = isActive(job);
  const box = $('.pick-box', card);
  box.disabled = !ready || busy;
  box.checked = ready && !busy && state.selected.has(video.id);
  select.disabled = !ready || busy;
  $('.save', card).disabled = !ready || busy;
  $('.copy', card).disabled = !video.url;
  $('.open', card).disabled = !video.url;

  const status = $('.status', card);
  if (job) renderStatus(status, job);
  else if (!ready && video.status !== 'resolving' && video.error) {
    status.hidden = false;
    status.classList.toggle('error', video.status === 'error');
    status.classList.remove('complete');
    $('.status-text', status).textContent = video.error;
    for (const button of status.querySelectorAll('button')) button.hidden = true;
    $('progress', status).hidden = true;
  } else status.hidden = true;
}

function renderVideos() {
  const list = $('#videos');
  const videos = state.page?.videos || [];
  for (const video of videos) {
    // Pre-select real embeds once they're ready; links on the page stay opt-in.
    if (video.status === 'ready' && !state.seenReady.has(video.id)) {
      state.seenReady.add(video.id);
      if (AUTO_SELECT.has(video.source)) state.selected.add(video.id);
    }
  }
  const cards = new Map([...list.children].map(card => [card.dataset.id, card]));
  videos.forEach((video, index) => {
    const card = cards.get(video.id) || createVideoCard(video.id);
    cards.delete(video.id);
    if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
    updateVideoCard(card, video);
  });
  for (const card of cards.values()) card.remove();

  const resolving = videos.some(video => video.status === 'resolving');
  const ready = videos.filter(video => video.status === 'ready').length;
  $('#video-count').textContent = videos.length || '';
  $('#loading').hidden = !(state.scanning && !videos.length);
  $('#empty').hidden = state.scanning || videos.length > 0 || Boolean(state.page?.blocked) || state.stale;
  $('#toolbar').hidden = !videos.length;
  $('#page-line').textContent = state.stale ? 'The page has changed'
    : state.scanning && !videos.length ? 'Looking for videos…'
    : resolving ? `Found ${videos.length} video${videos.length === 1 ? '' : 's'} · checking…`
    : videos.length ? `${ready} of ${videos.length} video${videos.length === 1 ? '' : 's'} can be saved`
    : state.page?.title || state.tab?.title || 'This page';
  renderSelection();
}

function renderSelection() {
  const videos = (state.page?.videos || []).filter(downloadable);
  for (const id of state.selected) if (!videos.some(video => video.id === id)) state.selected.delete(id);
  const count = state.selected.size;
  const all = $('#select-all');
  all.disabled = !videos.length;
  all.checked = videos.length > 0 && count === videos.length;
  all.indeterminate = count > 0 && count < videos.length;
  $('#download-selected').disabled = !count;
  $('#download-label').textContent = count ? `Download ${count} video${count === 1 ? '' : 's'}` : 'Download selected';
  $('#download-all').disabled = !videos.length;
}

async function startDownloads(ids) {
  const items = ids.map(id => ({id, formatId: state.choices.get(id) || ''}));
  const buttons = [$('#download-selected'), $('#download-all')];
  buttons.forEach(button => { button.disabled = true; });
  try {
    const {count, skipped} = await send('DOWNLOAD', {tabId: state.tabId, items, quality: $('#quality').value});
    for (const id of ids) state.selected.delete(id);
    notify(`${count} download${count === 1 ? '' : 's'} started${skipped ? `, ${skipped} skipped` : ''}.`);
  } catch (error) {
    notify(error.message, {error: true});
  } finally {
    renderVideos();
  }
}

async function rescan() {
  if (state.scanning || state.tabId == null) return;
  state.scanning = true;
  $('#rescan').classList.add('spinning');
  $('#rescan').disabled = true;
  renderVideos();
  try {
    state.tab = await chrome.tabs.get(state.tabId).catch(() => state.tab);
    const scanned = await send('SCAN', {tabId: state.tabId});
    // Use what's stored now: results may already be in, or the tab may have
    // navigated away (and its page been dropped) while the scan was running.
    const stored = (await chrome.storage.session.get(pageKey()))[pageKey()];
    state.scanning = false;
    // Prefer what's stored, even a newer scan from another view; only a
    // missing page means the tab moved on.
    if (stored) setPage(stored);
    else {
      setPage(scanned);
      pageGone();
    }
  } catch (error) {
    notify(error.message, {error: true, sticky: true});
  } finally {
    state.scanning = false;
    $('#rescan').classList.remove('spinning');
    $('#rescan').disabled = false;
    renderVideos();
  }
}

function setPage(page) {
  if (page?.scanId !== state.page?.scanId) {
    state.seenReady.clear();
    state.selected.clear();
  }
  state.page = page;
  state.stale = false;
  renderVideos();
  showPageNotice();
}

function pageGone() {
  if (!state.page || state.scanning) return;
  state.page = null;
  state.stale = true;
  state.selected.clear();
  renderVideos();
  notify('This page has changed. Click the rescan button to look for videos again.', {sticky: true});
}

// ------------------------------------------------------------------ downloads

function createJobCard(id) {
  const card = $('#job-template').content.firstElementChild.cloneNode(true);
  card.dataset.id = id;
  $('.remove', card).addEventListener('click', async () => {
    try { await send('REMOVE', {id}); } catch (error) { notify(error.message, {error: true}); }
  });
  $('img', card).addEventListener('error', event => event.target.removeAttribute('src'));
  wireStatus($('.status', card), () => state.jobs[id]);
  return card;
}

function renderJobs() {
  const list = $('#jobs');
  const jobs = Object.values(state.jobs).sort((a, b) => b.createdAt - a.createdAt);
  const cards = new Map([...list.children].map(card => [card.dataset.id, card]));
  jobs.forEach((job, index) => {
    const card = cards.get(job.id) || createJobCard(job.id);
    cards.delete(job.id);
    if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
    $('.title', card).textContent = job.video?.title || 'Vimeo video';
    $('.title', card).title = job.video?.title || '';
    $('.filename', card).textContent = job.filename ? job.filename.split('/').pop() : '';
    $('.remove', card).title = isActive(job) ? 'Cancel and remove' : 'Remove from list';
    const image = $('img', card);
    if (job.video?.thumbnail && image.dataset.src !== job.video.thumbnail) {
      image.dataset.src = job.video.thumbnail;
      image.src = job.video.thumbnail;
    }
    renderStatus($('.status', card), job);
  });
  for (const card of cards.values()) card.remove();

  const active = jobs.filter(isActive).length;
  const finished = jobs.length - active;
  const count = $('#job-count');
  count.textContent = active || '';
  count.classList.toggle('active', active > 0);
  $('#jobs-empty').hidden = jobs.length > 0;
  $('#clear').hidden = !finished;
  $('#downloads-summary').textContent = jobs.length
    ? [active && `${active} in progress`, finished && `${finished} finished`].filter(Boolean).join(' · ')
    : '';
}

function setJobs(jobs) {
  for (const [id, job] of Object.entries(jobs)) {
    const before = state.jobs[id];
    if (before && before.phase !== job.phase) {
      if (job.phase === 'complete') announce(`Saved ${job.video?.title || 'video'}.`);
      if (job.phase === 'error') announce(`Couldn’t save ${job.video?.title || 'video'}.`);
    }
  }
  state.jobs = jobs;
  renderJobs();
  renderVideos();
}

// ------------------------------------------------------------------ view switching

function showView(view, focus = false) {
  state.view = view;
  for (const name of ['videos', 'downloads']) {
    const tab = $(`#tab-${name}`);
    const selected = name === view;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(`#view-${name}`).hidden = !selected;
    if (selected && focus) tab.focus();
  }
  $('#footer').hidden = view !== 'videos';
}

$('#tab-videos').addEventListener('click', () => showView('videos'));
$('#tab-downloads').addEventListener('click', () => showView('downloads'));
$('.tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  showView(state.view === 'videos' ? 'downloads' : 'videos', true);
});

// ------------------------------------------------------------------ wiring

$('#rescan').addEventListener('click', rescan);
$('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#select-all').addEventListener('change', event => {
  for (const video of (state.page?.videos || []).filter(downloadable)) {
    if (event.target.checked) state.selected.add(video.id); else state.selected.delete(video.id);
  }
  renderVideos();
});
$('#download-selected').addEventListener('click', () => startDownloads([...state.selected]));
$('#download-all').addEventListener('click', () =>
  startDownloads((state.page?.videos || []).filter(downloadable).map(video => video.id)));
$('#quality').addEventListener('change', event => chrome.storage.local.set({quality: event.target.value}));
$('#clear').addEventListener('click', () => send('CLEAR_FINISHED').catch(error => notify(error.message, {error: true})));
$('#add-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('#add-url');
  const url = input.value.trim();
  if (!url) return input.focus();
  try {
    await send('ADD_LINK', {tabId: state.tabId, url});
    input.value = '';
    showView('videos');
  } catch (error) { notify(error.message, {error: true}); }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  let jobsChanged = false;
  const jobs = {...state.jobs};
  for (const [key, {newValue}] of Object.entries(changes)) {
    if (key.startsWith('job:')) {
      jobsChanged = true;
      if (newValue) jobs[newValue.id] = newValue;
      else delete jobs[key.slice(4)];
    } else if (key === pageKey()) {
      if (!newValue) pageGone();
      else if (newValue.scanId !== state.page?.scanId) setPage(newValue);
      else { state.page = newValue; renderVideos(); }
    }
  }
  if (jobsChanged) setJobs(jobs);
});

// The service worker only learns about direct-MP4 progress when asked.
setInterval(() => {
  if (Object.values(state.jobs).some(isActive)) send('POLL').catch(() => {});
}, 1500);
// Refresh relative bits (recent-job visibility) now and then.
setInterval(renderVideos, 30_000);

async function init() {
  const params = new URLSearchParams(location.search);
  if (params.has('tabId') && innerWidth > 500) document.body.classList.add('as-page');
  const tabId = Number(params.get('tabId')) || (await chrome.tabs.query({active: true, currentWindow: true}))[0]?.id;
  state.tabId = tabId ?? null;
  state.tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
  state.settings = await loadSettings();

  const quality = $('#quality');
  for (const [value, label] of QUALITIES) quality.append(new Option(label, value));
  quality.value = state.settings.quality;

  const session = await chrome.storage.session.get(null);
  state.jobs = Object.fromEntries(Object.entries(session)
    .filter(([key]) => key.startsWith('job:')).map(([, job]) => [job.id, job]));
  renderJobs();
  send('MARK_SEEN').catch(() => {});

  const page = session[pageKey()];
  const age = page ? Date.now() - page.scannedAt : Infinity;
  // Reuse a recent scan, unless it hit errors or seems to have stalled.
  const fresh = page && page.url === state.tab?.url && age < 2 * 60_000 &&
    !page.videos.some(video => video.status === 'error' || (video.status === 'resolving' && age > 30_000));
  if (fresh) setPage(page);
  else await rescan();

  // Nothing to grab here but something is downloading: show that instead.
  if (!state.page?.videos.length && Object.values(state.jobs).some(isActive)) showView('downloads');
}

init().catch(error => notify(error.message, {error: true, sticky: true}));
