// The service worker's job state machine, run against a fake chrome.* (see
// fake-chrome.mjs). Each test reproduces a race or failure found in review.
import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {loadBackground, fakeVimeo, mp4Format, hlsFormat, seedPage} from './fake-chrome.mjs';

let ext;
afterEach(() => ext?.restore());

const withTimeout = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve('TIMED OUT'), ms))]);

test('a failed storage write recovers instead of freezing every later update', async () => {
  ext = await loadBackground({quotaFailures: 1});
  seedPage(ext.store, [['111111', mp4Format(1)]]);
  const result = await withTimeout(ext.send({type: 'DOWNLOAD', tabId: 7, items: [{id: '111111'}]}), 3000);
  assert.deepEqual(result, {ok: true, data: {count: 1, skipped: 0}});
  assert.equal((await withTimeout(ext.send({type: 'MARK_SEEN'}), 2000)).ok, true);
});

test('cancelling a right-click download while it is still preparing stops it completely', async () => {
  ext = await loadBackground({fetch: fakeVimeo({delay: 300})});
  ext.listeners.menu[0]({linkUrl: 'https://vimeo.com/123456789'}, {id: 7, url: 'https://example.com/lesson'});
  await ext.sleep(100);
  const [job] = ext.jobs();
  assert.equal(job.phase, 'preparing');
  await ext.send({type: 'CANCEL', id: job.id});
  await ext.sleep(800);
  assert.equal(ext.jobs()[0].phase, 'cancelled');
  assert.deepEqual(ext.log.filter(entry => entry.startsWith('download:') || entry === 'offscreen:ENQUEUE'), []);
});

test('a download that finishes before its id is recorded still completes the job', async () => {
  ext = await loadBackground();
  ext.state.onDownloadCreated = id => setTimeout(() => ext.finishDownload(id), 0);
  seedPage(ext.store, [['111111', mp4Format(1)]]);
  await ext.send({type: 'DOWNLOAD', tabId: 7, items: [{id: '111111'}]});
  await ext.sleep(200);
  assert.equal(ext.jobs()[0].phase, 'complete');
});

test('jobs waiting in a long mixed batch are not mistaken for lost ones', async () => {
  ext = await loadBackground();
  const download = chrome.downloads.download;
  chrome.downloads.download = async options => { await ext.sleep(40); return download(options); };
  seedPage(ext.store, [['111111', mp4Format(1)], ['222222', mp4Format(2)], ['333333', hlsFormat]]);
  const pending = ext.send({type: 'DOWNLOAD', tabId: 7, items: [{id: '111111'}, {id: '222222'}, {id: '333333'}]});
  while (!ext.log.some(entry => entry.startsWith('download:'))) await ext.sleep(1);
  ext.state.clock += 20_000; // As if each start had been slow.
  await ext.send({type: 'POLL'});
  await pending;
  assert.deepEqual(ext.jobs().map(job => job.phase).sort(), ['downloading', 'downloading', 'queued']);
  assert.ok(!ext.log.some(entry => entry.startsWith('cancel:')));
});

test('a second retry is not undone by the first one finishing', async () => {
  let calls = 0;
  ext = await loadBackground({fetch: fakeVimeo({delay: () => (++calls === 1 ? 150 : 2000)})});
  seedPage(ext.store, [['111111', mp4Format(1)]]);
  ext.store['job:J'] = {id: 'J', attempt: 1, createdAt: 1, phase: 'error', error: 'x', seen: true, tabId: 7,
    pageUrl: 'https://example.com/lesson', filename: 'Vimeo/a.mp4', format: mp4Format(1),
    video: {id: '111111', playerUrl: 'https://player.vimeo.com/video/111111', url: 'https://vimeo.com/111111', source: 'manual', title: 'V'}};
  const first = ext.send({type: 'RETRY', id: 'J'});
  await ext.sleep(50);
  await ext.send({type: 'CANCEL', id: 'J'});
  const second = ext.send({type: 'RETRY', id: 'J'});
  await first;
  ext.state.clock += 16_000;
  await ext.send({type: 'POLL'});
  assert.equal(ext.store['job:J'].phase, 'preparing', 'still preparing, not "stopped unexpectedly"');
  await second;
  assert.equal(ext.store['job:J'].attempt, 3);
  assert.equal(ext.store['job:J'].phase, 'downloading');
});

test('a direct file that turns into a stream on refresh is handed to the stream downloader', async () => {
  ext = await loadBackground({fetch: fakeVimeo({hlsOnly: true})});
  const expiring = {...mp4Format(1), url: 'https://vod-progressive.akamaized.net/exp=1000000000~acl=x/1.mp4'};
  seedPage(ext.store, [['111111', expiring]]);
  await ext.send({type: 'DOWNLOAD', tabId: 7, items: [{id: '111111'}]});
  const [job] = ext.jobs();
  assert.equal(job.format.kind, 'hls');
  assert.equal(ext.log.filter(entry => entry === 'offscreen:ENQUEUE').length, 1);
  assert.ok(!ext.log.some(entry => entry.startsWith('download:')), 'no playlist saved as .mp4');
  // Nothing is left marked busy: once the downloader forgets it, it's reported lost.
  ext.state.offscreenIds = [];
  ext.state.clock += 20_000;
  await ext.send({type: 'POLL'});
  assert.equal(ext.jobs()[0].phase, 'error');
});

test('opening the popup never hides a failure that happens afterwards', async () => {
  ext = await loadBackground();
  seedPage(ext.store, [['111111', mp4Format(1)]]);
  await ext.send({type: 'DOWNLOAD', tabId: 7, items: [{id: '111111'}]});
  await ext.send({type: 'MARK_SEEN'});
  const [job] = ext.jobs();
  ext.finishDownload(job.downloadId, 'interrupted', 'NETWORK_FAILED');
  await ext.sleep(400);
  assert.equal(ext.jobs()[0].phase, 'error');
  assert.equal(ext.jobs()[0].seen, false);
  assert.equal(ext.state.badge, '!');
});

test('only the extension’s own pages can send commands, and only the downloader can report progress', async () => {
  ext = await loadBackground();
  seedPage(ext.store, [['111111', mp4Format(1)]]);
  assert.equal(await ext.send({type: 'DOWNLOAD', tabId: 7, items: [{id: '111111'}]}, 'https://evil.example/'), undefined);
  assert.equal(ext.jobs().length, 0);
  assert.equal(await ext.send({type: 'SAVE', id: 'x', url: 'blob:chrome-extension://ext/1'}), undefined, 'popup cannot SAVE');
  assert.equal(await ext.send({type: 'DOWNLOAD', tabId: 7, items: []}, 'offscreen/offscreen.html'), undefined,
    'downloader cannot start downloads');
});

test('a vimeo.com page framed by another site is looked up without cookies', async () => {
  const calls = [];
  ext = await loadBackground({
    fetch: fakeVimeo({calls}),
    executeScript: async () => [
      {frameId: 0, result: {url: 'https://example.com/lesson', top: true, items: [], configs: []}},
      {frameId: 3, result: {url: 'https://vimeo.com/123456', top: false, configs: [],
        items: [{url: 'https://vimeo.com/123456', title: 'Framed', source: 'page'}]}},
    ],
  });
  await ext.send({type: 'SCAN', tabId: 7});
  await ext.sleep(300);
  const [video] = ext.store['page:7'].videos;
  assert.equal(video.source, 'embed');
  const config = calls.find(call => call.url.includes('/config'));
  assert.equal(config.credentials, 'omit');
});

test('a pasted link is looked up with cookies, for private videos you can watch', async () => {
  const calls = [];
  ext = await loadBackground({fetch: fakeVimeo({calls})});
  await ext.send({type: 'ADD_LINK', tabId: 7, url: 'https://vimeo.com/123456'});
  await ext.sleep(300);
  assert.equal(ext.store['page:7'].videos[0].status, 'ready');
  assert.equal(calls.find(call => call.url.includes('/config')).credentials, 'include');
});
