// Vimeo URL and player-config helpers. Pure functions: no chrome.* APIs, so
// they run unchanged in the service worker, the offscreen page and Node tests.

const VIMEO_HOST = /(^|\.)vimeo\.com$/i;
const HASH = '([0-9a-f]{6,64})';
const ID = '(\\d{1,15})';

// Paths on vimeo.com that point at a single video. Anything else (showcases,
// channels, events, user pages, settings) is ignored on purpose.
const SITE_PATHS = [
  new RegExp(`^/(\\d{5,15})(?:/${HASH})?/?$`, 'i'),
  new RegExp(`^/video/${ID}(?:/${HASH})?/?$`, 'i'),
  new RegExp(`^/channels/[\\w-]+/${ID}/?$`, 'i'),
  new RegExp(`^/groups/[\\w-]+/videos/${ID}/?$`, 'i'),
  new RegExp(`^/(?:album|showcase)/\\d+/video/${ID}/?$`, 'i'),
  new RegExp(`^/manage/videos/${ID}(?:/${HASH})?/?$`, 'i'),
  new RegExp(`^/ondemand/[\\w-]+/${ID}/?$`, 'i'),
];
const PLAYER_PATH = new RegExp(`^/video/${ID}(?:/config)?/?$`, 'i');

/**
 * Normalise any Vimeo video URL (player embed, public page, unlisted link,
 * config endpoint) to a reference, or return null if it is not a video.
 */
export function vimeoRef(value, base = 'https://vimeo.com/') {
  let url;
  try { url = new URL(String(value), base); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || !VIMEO_HOST.test(url.hostname)) return null;
  const host = url.hostname.toLowerCase();
  let match = null;
  if (host === 'player.vimeo.com') match = url.pathname.match(PLAYER_PATH);
  else if (host === 'vimeo.com' || host === 'www.vimeo.com') {
    for (const pattern of SITE_PATHS) if ((match = url.pathname.match(pattern))) break;
  }
  if (!match) return null;
  const id = match[1];
  const hashParam = url.searchParams.get('h');
  const hash = (hashParam && /^[0-9a-f]{6,64}$/i.test(hashParam) ? hashParam : match[2] || '').toLowerCase();
  const playerUrl = new URL(`https://player.vimeo.com/video/${id}`);
  if (hash) playerUrl.searchParams.set('h', hash);
  return {id, hash, playerUrl: playerUrl.href, url: `https://vimeo.com/${id}${hash ? '/' + hash : ''}`};
}

// Hosts the extension is ever allowed to fetch from. Page-supplied data can
// name arbitrary URLs, so every network request is checked against this list
// (and the extension's CSP repeats it as connect-src, which also covers redirects).
const MEDIA_HOSTS = [/^(?:www\.|player\.|captions\.)?vimeo\.com$/i, /\.vimeocdn\.com$/i];
// Direct MP4 files from older uploads can come from Vimeo's Akamai host.
const DOWNLOAD_HOSTS = [...MEDIA_HOSTS, /^vod-progressive(?:-ak)?\.akamaized\.net$/i];

function allowed(value, hosts, base) {
  try {
    const url = new URL(value, base);
    return url.protocol === 'https:' && hosts.some(host => host.test(url.hostname)) ? url.href : null;
  } catch { return null; }
}

/** An https URL on a Vimeo host the extension may fetch, or null. */
export const mediaUrl = (value, base) => allowed(value, MEDIA_HOSTS, base);
/** An https URL Chrome may download directly (adds Vimeo's legacy MP4 CDN), or null. */
export const downloadUrl = (value, base) => allowed(value, DOWNLOAD_HOSTS, base);
export const usesCookies = value => /(^|\.)vimeo\.com$/i.test(new URL(value).hostname);

/**
 * Pull `playerConfig = {...}` style JSON out of HTML or script text without
 * evaluating anything. Returns parsed configs that look like Vimeo's.
 */
export function configsFromText(text) {
  const configs = [];
  const markers = /(?:playerConfig|player_config|clip_page_config)\s*=\s*|"config"\s*:\s*(?=\{)/g;
  while (markers.exec(text)) {
    let start = markers.lastIndex;
    while (start < text.length && /\s/.test(text[start])) start++;
    if (text[start] !== '{') continue;
    const end = jsonObjectEnd(text, start);
    if (end < 0) continue;
    try {
      let config = JSON.parse(text.slice(start, end + 1));
      if (config.player?.config_url && !config.video) config = {configUrl: config.player.config_url};
      if (config.video?.id || config.configUrl) configs.push(config);
    } catch { /* Not every assignment is JSON. */ }
    markers.lastIndex = end + 1;
  }
  return configs;
}

/** Index of the brace closing the JSON object that starts at `start`, or -1. */
export function jsonObjectEnd(text, start) {
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Turn a Vimeo player config into the facts the extension needs. Every URL is
 * filtered through the host allowlist; nothing from the config is trusted.
 */
export function parseConfig(config, candidate = {}) {
  const video = config?.video || {};
  const request = config?.request || {};
  const files = request.files || {};
  const id = String(video.id || candidate.id || '');
  const hash = String(video.unlisted_hash || candidate.hash || '').toLowerCase();
  const progressive = (Array.isArray(files.progressive) ? files.progressive : [])
    .map(item => ({
      kind: 'mp4',
      url: downloadUrl(item?.url),
      width: Number(item?.width) || 0,
      height: Number(item?.height) || parseInt(item?.quality, 10) || 0,
      fps: Number(item?.fps) || 0,
      size: Number(item?.size) || 0,
    }))
    .filter(item => item.url);
  const hls = files.hls || {};
  const cdns = Object.entries(hls.cdns || {})
    .sort(([a], [b]) => (b === hls.default_cdn) - (a === hls.default_cdn));
  // H.264 playlists first: they play everywhere and in every editor.
  const masters = [...new Set([
    ...cdns.map(([, cdn]) => cdn?.avc_url),
    ...cdns.map(([, cdn]) => cdn?.url),
  ].map(url => mediaUrl(url)).filter(Boolean))];
  const textTracks = (Array.isArray(request.text_tracks) ? request.text_tracks : [])
    .map(track => ({
      id: String(track?.id ?? ''),
      lang: String(track?.lang || 'und').replace(/[^\w-]/g, '').slice(0, 20) || 'und',
      label: String(track?.label || track?.lang || 'Subtitles').slice(0, 80),
      kind: String(track?.kind || 'subtitles'),
      default: Boolean(track?.default),
      url: mediaUrl(track?.url, 'https://player.vimeo.com/'),
    }))
    .filter(track => track.url);
  const thumbs = video.thumbs || {};
  const thumbnail = mediaUrl(video.thumbnail_url || thumbs['640'] || thumbs['960'] || thumbs.base);
  const liveStatus = video.live_event?.status;
  return {
    id,
    hash,
    title: cleanText(video.title) || candidate.title || `Vimeo ${id}`,
    owner: cleanText(video.owner?.name),
    duration: Number(video.duration) || 0,
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    thumbnail,
    live: Boolean(liveStatus && liveStatus !== 'ended' && liveStatus !== 'archived'),
    // Only DRM renditions on offer (hls_cenc / dash_cenc): nothing we may save.
    protected: !masters.length && !progressive.length && Boolean(files.hls_cenc || files.dash_cenc),
    // Signed URL the player itself uses to renew expired links for this embed.
    refreshUrl: mediaUrl(request.config_refresh_url) || null,
    progressive,
    masters,
    textTracks,
  };
}

function cleanText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
}

/** Seconds until a signed Vimeo CDN URL expires, or Infinity if unsigned. */
export function secondsUntilExpiry(url, now = Date.now()) {
  const match = String(url).match(/[/?&~]exp=(\d{9,11})/);
  return match ? Number(match[1]) - now / 1000 : Infinity;
}
