// Renders README screenshots of the real popup and options page, filled with
// made-up demo data (no real videos or thumbnails). Needs Puppeteer's Chrome:
//   npx puppeteer browsers install chrome && node scripts/screenshots.mjs
import {createServer} from 'node:http';
import {cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import puppeteer from 'puppeteer';

const EXTENSION = fileURLToPath(new URL('../extension/', import.meta.url));
const OUT = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
mkdirSync(OUT, {recursive: true});

const thumb = (from, to) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><defs><linearGradient id="g" x2="1" y2="1">
  <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
  <rect width="160" height="90" fill="url(#g)"/><circle cx="80" cy="45" r="16" fill="#fff" fill-opacity=".85"/>
  <path d="M75 37v16l13-8z" fill="${to}"/></svg>`);

const format = (height, size) => ({id: `hls-${height}`, kind: 'hls', height, width: Math.round(height * 16 / 9),
  label: height >= 2160 ? '4K' : `${height}p`, size, url: 'https://example.invalid', audioUrl: 'https://example.invalid'});
const formats = scale => [format(1080, 412e6 * scale), format(720, 214e6 * scale), format(540, 118e6 * scale),
  format(360, 61e6 * scale), {id: 'audio', kind: 'hls', audioOnly: true, label: 'Audio', size: 0}];

function demo(tabId, url, now) {
  const videos = [
    {id: '900000001', title: 'Studio tour: how we built the new workshop', owner: 'Northwind Studio', duration: 754,
      thumbnail: thumb('#6d5efc', '#2d1f8f'), source: 'player', status: 'ready', formats: formats(1)},
    {id: '900000002', title: 'Product walkthrough (2026 edition)', owner: 'Northwind Studio', duration: 312,
      thumbnail: thumb('#ff9a62', '#c23d5e'), source: 'embed', status: 'ready', formats: formats(0.4)},
    {id: '900000003', title: 'Behind the scenes: lighting a small set', owner: 'Ada Lumen', duration: 1488,
      thumbnail: thumb('#38c7a5', '#155e75'), source: 'link', status: 'ready', formats: formats(2)},
    {id: '900000004', title: 'Members-only premiere', owner: 'Streaming Co', duration: 5400,
      thumbnail: thumb('#4b5563', '#111827'), source: 'link', status: 'protected', formats: [],
      error: 'This video is DRM-protected by its owner, so it can’t be downloaded.'},
  ].map(video => ({...video, url: `https://vimeo.com/${video.id}`, playerUrl: `https://player.vimeo.com/video/${video.id}`,
    hash: '', textTracks: []}));
  const job = (id, video, extra) => ({id, createdAt: now - 1000 * extra.age, updatedAt: now, tabId, pageUrl: url,
    video: {id: video.id, title: video.title, owner: video.owner, thumbnail: video.thumbnail, url: video.url},
    format: video.formats[0], filename: `Vimeo/${video.title} [${video.id}] 1080p.mp4`, ...extra});
  // The active demo job is a direct MP4 with no download id, so the popup's
  // health check (which would flag a stream with no downloader) leaves it alone.
  const jobs = [
    job('a', videos[0], {age: 40, phase: 'downloading', progress: 62, bytes: 255e6, size: 412e6, speed: 6.4e6, eta: 25,
      format: {...videos[0].formats[0], kind: 'mp4'}}),
    job('b', videos[1], {age: 300, phase: 'complete', progress: 100, bytes: 165e6, downloadId: 1}),
    job('c', {...videos[2], title: 'Quarterly all-hands recording'}, {age: 900, phase: 'error',
      error: 'Vimeo refused access. The link may have expired. Rescan the page and try again.'}),
  ];
  // Same layout as background.js: one session-storage key per page and per job.
  return {
    [`page:${tabId}`]: {tabId, url, title: 'Northwind Studio – Films', scanId: 'demo', scannedAt: now, notice: '', blocked: false, videos},
    ...Object.fromEntries(jobs.map(item => [`job:${item.id}`, {attempt: 1, seen: true, ...item}])),
  };
}

const server = createServer((request, response) => {
  response.writeHead(200, {'content-type': 'text/html'});
  response.end('<!doctype html><title>Northwind Studio – Films</title><h1>Films</h1>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;
const work = mkdtempSync(join(tmpdir(), 'vimeo-grab-shots-'));
// Same test-only tweak as the e2e suite: let the extension see the local page.
const extension = join(work, 'extension');
cpSync(EXTENSION, extension, {recursive: true});
const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('http://127.0.0.1/*');
writeFileSync(join(extension, 'manifest.json'), JSON.stringify(manifest));
const profile = join(work, 'profile');
const browser = await puppeteer.launch({headless: true, pipe: true, enableExtensions: [extension], userDataDir: profile});

try {
  const target = await browser.waitForTarget(item => item.type() === 'service_worker' && item.url().endsWith('/background.js'));
  const worker = await target.worker();
  const id = new URL(target.url()).host;
  for (const page of await browser.pages()) if (page.url().includes('options.html')) await page.close();
  const site = await browser.newPage();
  await site.goto(pageUrl);
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id, pageUrl);

  for (const scheme of ['light', 'dark']) {
    await worker.evaluate(data => chrome.storage.session.set(data), demo(tabId, pageUrl, Date.now()));
    const popup = await browser.newPage();
    await popup.emulateMediaFeatures([{name: 'prefers-color-scheme', value: scheme}]);
    await popup.setViewport({width: 420, height: 600, deviceScaleFactor: 2});
    await popup.goto(`chrome-extension://${id}/popup/popup.html?tabId=${tabId}&screenshot=1`);
    await popup.waitForSelector('.card[data-id="900000003"]');
    await new Promise(resolve => setTimeout(resolve, 300));
    await popup.screenshot({path: join(OUT, `popup-${scheme}.png`)});
    await popup.click('#tab-downloads');
    await new Promise(resolve => setTimeout(resolve, 200));
    await popup.screenshot({path: join(OUT, `downloads-${scheme}.png`)});
    await popup.close();
  }

  const options = await browser.newPage();
  await options.setViewport({width: 760, height: 1300, deviceScaleFactor: 1.5});
  await options.goto(`chrome-extension://${id}/options/options.html`);
  await options.waitForFunction(() => document.querySelector('#preview').textContent.length > 0);
  await options.screenshot({path: join(OUT, 'options.png'), fullPage: true});
  console.log(`Saved screenshots to ${OUT}`);
} finally {
  await browser.close();
  server.close();
  rmSync(work, {recursive: true, force: true});
}
