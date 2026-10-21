// A small in-memory chrome.* for running extension/background.js under Node.
// Each call to loadBackground() gets a fresh fake and a fresh module instance.
import {pathToFileURL, fileURLToPath} from 'node:url';

const BACKGROUND = pathToFileURL(fileURLToPath(new URL('../extension/background.js', import.meta.url))).href;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let instance = 0;

export async function loadBackground({fetch: fakeFetch, quotaFailures = 0, executeScript = async () => []} = {}) {
  const store = {};
  const listeners = {message: [], downloadChanged: [], menu: [], startup: [], updated: [], removed: []};
  const log = [];
  const downloads = new Map();
  const state = {quotaFailures, offscreenOpen: false, offscreenIds: [], nextDownload: 1, clock: 0,
    onDownloadCreated: () => {}};
  const realNow = Date.now;
  Date.now = () => realNow() + state.clock;
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch || (async () => new Response('not found', {status: 404}));

  const pick = keys => {
    if (keys == null) return structuredClone(store);
    if (typeof keys === 'string') return keys in store ? {[keys]: structuredClone(store[keys])} : {};
    if (Array.isArray(keys)) return Object.fromEntries(keys.filter(key => key in store).map(key => [key, structuredClone(store[key])]));
    return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, key in store ? structuredClone(store[key]) : fallback]));
  };
  const event = list => ({addListener: fn => list.push(fn)});
  const ipc = () => sleep(2);

  globalThis.chrome = {
    storage: {
      session: {
        get: async keys => { await ipc(); return pick(keys); },
        set: async items => {
          await ipc();
          if (state.quotaFailures > 0) {
            state.quotaFailures--;
            throw new Error('Session storage quota bytes exceeded. Values were not stored.');
          }
          Object.assign(store, structuredClone(items));
        },
        remove: async keys => { await ipc(); for (const key of [].concat(keys)) delete store[key]; },
        getKeys: async () => { await ipc(); return Object.keys(store); },
      },
      local: {get: async () => ({})},
    },
    action: {setBadgeText: async ({text}) => { state.badge = text; }, setBadgeBackgroundColor: async () => {}},
    runtime: {
      id: 'ext',
      getURL: path => `chrome-extension://ext/${path}`,
      onMessage: event(listeners.message),
      onInstalled: event([]),
      onStartup: event(listeners.startup),
      getContexts: async () => (state.offscreenOpen ? [{}] : []),
      // Messages from the service worker go to the offscreen page.
      sendMessage: async message => {
        log.push(`offscreen:${message.type}`);
        if (message.type === 'ENQUEUE') state.offscreenIds.push(...message.jobs.map(job => job.id));
        return {ok: true, data: message.type === 'STATUS' ? {ids: state.offscreenIds} : null};
      },
      openOptionsPage: async () => {},
    },
    downloads: {
      download: async options => {
        const id = state.nextDownload++;
        downloads.set(id, {id, state: 'in_progress', filename: `C:\\Downloads\\${options.filename}`, ...options});
        log.push(`download:${options.filename}`);
        state.onDownloadCreated(id);
        return id;
      },
      cancel: async id => {
        log.push(`cancel:${id}`);
        if (downloads.has(id)) downloads.get(id).state = 'interrupted';
      },
      search: async ({id}) => { await sleep(1); return downloads.has(id) ? [structuredClone(downloads.get(id))] : []; },
      show: () => {},
      onChanged: event(listeners.downloadChanged),
    },
    tabs: {
      get: async id => ({id, url: 'https://example.com/lesson', title: 'Lesson'}),
      onRemoved: event(listeners.removed),
      onUpdated: event(listeners.updated),
      TAB_ID_NONE: -1,
    },
    contextMenus: {removeAll: callback => callback?.(), create: () => {}, onClicked: event(listeners.menu)},
    scripting: {executeScript},
    offscreen: {
      createDocument: async () => { await sleep(10); state.offscreenOpen = true; log.push('offscreen:created'); },
      closeDocument: async () => { state.offscreenOpen = false; },
    },
    i18n: {getUILanguage: () => 'en-US'},
  };

  await import(`${BACKGROUND}?instance=${++instance}`);

  /** Send a runtime message as if from an extension page (popup by default). */
  const send = (message, from = 'popup/popup.html') => new Promise(resolve => {
    const url = /^[a-z]+:/.test(from) ? from : `chrome-extension://ext/${from}`;
    let answered = false;
    for (const listener of listeners.message) {
      if (listener(message, {id: 'ext', url}, value => { answered = true; resolve(value); }) === true) return;
    }
    if (!answered) resolve(undefined);
  });

  return {
    store, log, downloads, listeners, state, send, sleep,
    jobs: () => Object.entries(store).filter(([key]) => key.startsWith('job:')).map(([, job]) => job),
    /** Simulate Chrome finishing (or failing) a download. */
    finishDownload(id, result = 'complete', error) {
      downloads.get(id).state = result;
      for (const listener of listeners.downloadChanged) {
        listener({id, state: {previous: 'in_progress', current: result}, ...(error ? {error: {current: error}} : {})});
      }
    },
    restore() {
      Date.now = realNow;
      globalThis.fetch = realFetch;
      delete globalThis.chrome;
    },
  };
}

/** A fake Vimeo: player configs plus a one-rendition HLS stream. */
export function fakeVimeo({delay = 0, hlsOnly = false, calls = []} = {}) {
  const CDN = 'https://vod-adaptive-ak.vimeocdn.com/exp=1999999999~acl=x/';
  return async (url, init = {}) => {
    calls.push({url: String(url), credentials: init.credentials});
    await sleep(typeof delay === 'function' ? delay() : delay);
    const match = String(url).match(/player\.vimeo\.com\/video\/(\d+)\/config/);
    if (match) {
      const files = hlsOnly
        ? {hls: {default_cdn: 'a', cdns: {a: {avc_url: `${CDN}master.m3u8`}}}}
        : {progressive: [{url: `https://vod-progressive.akamaized.net/exp=1999999999~acl=x/${match[1]}.mp4`, width: 1280, height: 720, size: 1000}]};
      return new Response(JSON.stringify({video: {id: Number(match[1]), title: `Video ${match[1]}`, duration: 10,
        owner: {name: 'Owner'}}, request: {files}}), {status: 200});
    }
    if (String(url).endsWith('master.m3u8')) {
      return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,CODECS="avc1.64001f"\nv720/index.m3u8\n');
    }
    if (String(url).includes('index.m3u8')) return new Response('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg0.m4s\n#EXT-X-ENDLIST\n');
    return new Response('not found', {status: 404});
  };
}

export const mp4Format = id => ({id: 'mp4-720', kind: 'mp4', height: 720, label: '720p', size: 1,
  url: `https://vod-progressive.akamaized.net/exp=1999999999~acl=x/${id}.mp4`});
export const hlsFormat = {id: 'hls-720', kind: 'hls', height: 720, label: '720p', size: 1, audioUrl: null,
  url: 'https://vod-adaptive-ak.vimeocdn.com/exp=1999999999~acl=x/v720/index.m3u8'};

/** Seed a scanned page with ready videos on tab 7. */
export function seedPage(store, videos) {
  store['page:7'] = {tabId: 7, url: 'https://example.com/lesson', title: 'Lesson', scanId: 'scan', scannedAt: Date.now(),
    videos: videos.map(([id, format, source = 'embed']) => ({id, title: `Video ${id}`, url: `https://vimeo.com/${id}`,
      playerUrl: `https://player.vimeo.com/video/${id}`, hash: '', source, status: 'ready', formats: [format], textTracks: []}))};
}
