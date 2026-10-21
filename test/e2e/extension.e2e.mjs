// End-to-end test against live Vimeo, in Chrome for Testing via Puppeteer.
//
//   npx puppeteer browsers install chrome   (once)
//   npm run test:e2e
//
// Needs network access. It uses public videos: one ordinary embed and one
// that Vimeo serves only with DRM, which must be reported as protected.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import puppeteer from 'puppeteer';

const PLAIN_VIDEO = '1202195955'; // Public, unencrypted HLS.
const DRM_VIDEO = '76979871'; // Vimeo's own video; every rendition is DRM-encrypted.
const EXTENSION = fileURLToPath(new URL('../../extension/', import.meta.url));

let browser, server, worker, extensionId, workDir, pageUrl;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Vimeo Grab test page</title></head><body>
  <h1>Test page</h1>
  <iframe src="https://player.vimeo.com/video/${PLAIN_VIDEO}?badge=0" width="640" height="360" title="Embedded video" allow="autoplay; fullscreen"></iframe>
  <p><a href="https://vimeo.com/${DRM_VIDEO}">A linked video</a></p>
  <p><a href="https://vimeo.com/showcase/1234567">A showcase, not a video</a></p>
  <lite-vimeo videoid="${PLAIN_VIDEO}"></lite-vimeo>
</body></html>`;

/** Run code in the extension's service worker. */
const inWorker = (fn, ...args) => worker.evaluate(fn, ...args);
/** Session state as {pages: {tabId: page}, jobs: {id: job}} (stored as one key per page and job). */
async function session() {
  const items = await inWorker(() => chrome.storage.session.get(null));
  const pick = prefix => Object.fromEntries(Object.entries(items)
    .filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]));
  return {pages: pick('page:'), jobs: pick('job:')};
}

async function waitFor(check, {timeout = 60_000, interval = 250, message = 'condition'} = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${message}`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'vimeo-grab-e2e-'));
  // Test-only copy: allow the local test server, since activeTab needs a real click.
  const extensionDir = join(workDir, 'extension');
  cpSync(EXTENSION, extensionDir, {recursive: true});
  const manifestPath = join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions.push('http://127.0.0.1/*');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  server = createServer((request, response) => {
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    response.end(PAGE);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  pageUrl = `http://127.0.0.1:${server.address().port}/`;

  // A real profile preference, not CDP's download override: that one replaces
  // the file names chrome.downloads asks for, which is part of what we test.
  const profile = join(workDir, 'profile');
  mkdirSync(join(profile, 'Default'), {recursive: true});
  writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({
    download: {default_directory: join(workDir, 'downloads'), prompt_for_download: false, directory_upgrade: true},
  }));
  browser = await puppeteer.launch({headless: true, pipe: true, enableExtensions: [extensionDir], userDataDir: profile,
    args: ['--no-first-run', '--autoplay-policy=no-user-gesture-required']});
  const target = await browser.waitForTarget(item => item.type() === 'service_worker' && item.url().endsWith('/background.js'));
  worker = await target.worker();
  extensionId = new URL(target.url()).host;
  // The welcome page opens on install; it isn't needed here.
  for (const page of await browser.pages()) if (page.url().includes('options.html')) await page.close();
});

after(async () => {
  await browser?.close();
  server?.close();
  if (workDir) rmSync(workDir, {recursive: true, force: true});
});

async function openPopupFor(url) {
  const page = await browser.newPage();
  await page.goto(url, {waitUntil: 'networkidle2'});
  // Let the embedded player finish loading so its config is there to read.
  const player = await page.waitForFrame(frame => frame.url().includes('player.vimeo.com'), {timeout: 30_000});
  await player.waitForFunction(() => document.readyState === 'complete', {timeout: 30_000});
  const tabId = await inWorker(async target => (await chrome.tabs.query({url: target}))[0]?.id, url);
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html?tabId=${tabId}`);
  return {page, popup, tabId};
}

let ctx;

test('scans embeds, merges duplicates, ignores non-videos and flags DRM', {timeout: 90_000}, async () => {
  ctx = await openPopupFor(pageUrl);
  const page = await waitFor(async () => {
    const value = (await session()).pages[ctx.tabId];
    return value && value.videos.length && value.videos.every(video => video.status !== 'resolving') && value;
  }, {message: 'videos to resolve'});
  const ids = page.videos.map(video => video.id).sort();
  assert.deepEqual(ids, [PLAIN_VIDEO, DRM_VIDEO].sort());
  const plain = page.videos.find(video => video.id === PLAIN_VIDEO);
  const drm = page.videos.find(video => video.id === DRM_VIDEO);
  assert.equal(plain.status, 'ready', plain.error);
  assert.equal(plain.source, 'player', 'config read straight from the player frame');
  assert.ok(plain.formats.length >= 3);
  assert.ok(plain.thumbnail?.startsWith('https://i.vimeocdn.com/'));
  assert.equal(drm.status, 'protected', drm.error);

  // The popup shows both, with the protected one disabled and the embed pre-selected.
  await ctx.popup.waitForSelector(`.card[data-id="${PLAIN_VIDEO}"] .pick-box:checked`);
  const drmDisabled = await ctx.popup.$eval(`.card[data-id="${DRM_VIDEO}"] .pick-box`, box => box.disabled);
  assert.equal(drmDisabled, true);
  const label = await ctx.popup.$eval('#download-label', element => element.textContent);
  assert.equal(label, 'Download 1 video');
});

test('downloads a video as a regular, playable MP4', {timeout: 180_000}, async () => {
  const {popup} = ctx;
  const card = `.card[data-id="${PLAIN_VIDEO}"]`;
  const formatId = await popup.$eval(`${card} .format`, select =>
    [...select.options].find(option => /^360p/.test(option.textContent))?.value);
  assert.ok(formatId, '360p option offered');
  await popup.select(`${card} .format`, formatId);
  await popup.click(`${card} .save`);

  const job = await waitFor(async () => {
    const found = Object.values((await session()).jobs).find(item => item.video.id === PLAIN_VIDEO);
    if (found?.phase === 'error') throw new Error(found.error);
    return found?.phase === 'complete' && found;
  }, {timeout: 150_000, message: 'download to finish'});

  await popup.waitForFunction(selector => document.querySelector(selector)?.textContent.startsWith('Saved'),
    {}, `${card} .status-text`);
  const [item] = await inWorker(id => chrome.downloads.search({id}), job.downloadId);
  assert.equal(item.state, 'complete');
  assert.match(item.filename, new RegExp(`\\[${PLAIN_VIDEO}\\] 360p\\.mp4$`));
  assert.ok(existsSync(item.filename) && statSync(item.filename).size > 100_000);

  const data = readFileSync(item.filename);
  assert.equal(data.indexOf('moof'), -1, 'not a fragmented MP4');
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:format_tags=title:stream=codec_name,height',
    '-of', 'json', item.filename], {encoding: 'utf8'});
  if (probe.status === 0) {
    const info = JSON.parse(probe.stdout);
    assert.equal(info.streams[0].codec_name, 'h264');
    assert.equal(info.streams[0].height, 360);
    assert.ok(Math.abs(Number(info.format.duration) - 28) < 1, info.format.duration);
    assert.equal(info.format.tags.title, job.video.title);
    const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', item.filename, '-f', 'null', '-'], {encoding: 'utf8'});
    assert.equal(decode.stderr.trim(), '');
  }
});

test('cancelling stops the download and cleans up', {timeout: 90_000}, async () => {
  const {popup, tabId} = ctx;
  const best = (await session()).pages[tabId].videos.find(video => video.id === PLAIN_VIDEO).formats[0].id;
  await popup.evaluate((tab, id, formatId) => chrome.runtime.sendMessage({type: 'DOWNLOAD', tabId: tab, items: [{id, formatId}]}),
    tabId, PLAIN_VIDEO, best);
  const job = await waitFor(async () => Object.values((await session()).jobs)
    .find(item => item.format.id === best && item.phase === 'downloading'), {message: 'download to start'});
  await popup.evaluate(id => chrome.runtime.sendMessage({type: 'CANCEL', id}), job.id);
  await waitFor(async () => (await session()).jobs[job.id]?.phase === 'cancelled', {message: 'cancellation'});
  // The badge only counts active downloads.
  await waitFor(async () => (await inWorker(() => chrome.action.getBadgeText({}))) === '', {message: 'badge to clear'});
  // A late progress update from the cancelled run must not revive it.
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal((await session()).jobs[job.id].phase, 'cancelled');
  ctx.cancelledJob = job.id;
});

test('a cancelled download can be retried to completion', {timeout: 180_000}, async () => {
  const {popup} = ctx;
  const id = ctx.cancelledJob;
  const response = await popup.evaluate(job => chrome.runtime.sendMessage({type: 'RETRY', id: job}), id);
  assert.equal(response.ok, true, response.error);
  const job = await waitFor(async () => {
    const found = (await session()).jobs[id];
    if (found?.phase === 'error') throw new Error(found.error);
    return found?.phase === 'complete' && found;
  }, {timeout: 150_000, message: 'retried download to finish'});
  assert.equal(job.attempt, 2);
  const [item] = await inWorker(downloadId => chrome.downloads.search({id: downloadId}), job.downloadId);
  assert.ok(statSync(item.filename).size > 1_000_000);
});

test('the extension cannot reach anything but Vimeo, even with host access', {timeout: 30_000}, async () => {
  // The e2e copy has host access to the local server, yet the CSP still blocks it.
  const result = await inWorker(async url => {
    try { await fetch(url); return 'reached'; } catch (error) { return error.name; }
  }, pageUrl);
  assert.equal(result, 'TypeError');
  const vimeo = await inWorker(async () => (await fetch('https://player.vimeo.com/video/1202195955/config')).status);
  assert.equal(vimeo, 200);
});

test('a pasted link is resolved and added to the list', {timeout: 60_000}, async () => {
  const {popup, tabId} = ctx;
  await popup.evaluate(tab => chrome.runtime.sendMessage({type: 'ADD_LINK', tabId: tab, url: 'not a link'}), tabId)
    .then(response => assert.equal(response.ok, false));
  // Re-adding an existing video moves it to the top as a manual entry.
  const response = await popup.evaluate(tab => chrome.runtime.sendMessage({type: 'ADD_LINK', tabId: tab,
    url: 'https://vimeo.com/1202195955?share=copy'}), tabId);
  assert.equal(response.ok, true, response.error);
  const page = await waitFor(async () => {
    const value = (await session()).pages[tabId];
    return value?.videos[0]?.source === 'manual' && value.videos[0].status === 'ready' && value;
  }, {message: 'pasted link to resolve'});
  assert.equal(page.videos[0].id, PLAIN_VIDEO);
});

test('the service worker can clear leftover temp files (as it does at browser startup)', {timeout: 30_000}, async () => {
  // Startup cleanup runs in the service worker, so it must be able to reach
  // the same private storage the downloader writes temp files to.
  const remaining = await inWorker(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('vimeo-grab-temp', {create: true});
    await dir.getFileHandle('left-over.mp4', {create: true});
    for await (const name of dir.keys()) await dir.removeEntry(name);
    const names = [];
    for await (const name of dir.keys()) names.push(name);
    return names;
  });
  assert.deepEqual(remaining, []);
});

test('options page saves settings and previews file names', {timeout: 30_000}, async () => {
  const options = await browser.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html`);
  await options.waitForFunction(() => document.querySelector('#preview').textContent.length > 0);
  await options.$eval('#template', input => { input.value = ''; });
  await options.type('#template', '{owner} - {title}');
  await options.select('#quality', '720');
  await waitFor(async () => {
    const stored = await inWorker(() => chrome.storage.local.get(['template', 'quality']));
    return stored.template === '{owner} - {title}' && stored.quality === '720';
  }, {message: 'settings to save'});
  const preview = await options.$eval('#preview', element => element.textContent);
  assert.equal(preview, 'Vimeo/Studio Name - Our product tour.mp4');
  await options.close();
});
