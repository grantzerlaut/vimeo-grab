// HLS playlist parsing (RFC 8216), limited to what Vimeo serves: on-demand,
// unencrypted fragmented-MP4 streams with optional separate audio.
import {mediaUrl} from './vimeo.mjs';

export class ProtectedError extends Error {
  constructor(message = 'This video is DRM-protected by its owner, so it can’t be downloaded.') {
    super(message);
    this.name = 'ProtectedError';
    this.code = 'protected';
  }
}

export class UnsupportedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedError';
    this.code = 'unsupported';
  }
}

/** Parse an attribute list such as `BANDWIDTH=1,CODECS="a,b"`. */
export function attributes(line) {
  const result = {};
  const text = line.slice(line.indexOf(':') + 1);
  const pattern = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
  let match;
  while ((match = pattern.exec(text))) result[match[1]] = match[2] ?? match[3];
  return result;
}

const lines = text => text.split(/\r?\n/).map(line => line.trim());

function assertPlaylist(text) {
  if (!String(text).trimStart().startsWith('#EXTM3U')) {
    throw new UnsupportedError('Vimeo did not return a video playlist. Rescan and try again.');
  }
}

/**
 * Parse a master playlist into video variants and audio renditions.
 * URLs are resolved against `base` and must stay on Vimeo hosts.
 */
export function parseMaster(text, base) {
  assertPlaylist(text);
  const all = lines(text);
  const audio = all.filter(line => line.startsWith('#EXT-X-MEDIA:')).map(attributes)
    .filter(item => item.TYPE === 'AUDIO' && item.URI)
    .map(item => ({group: item['GROUP-ID'], url: mediaUrl(item.URI, base), default: item.DEFAULT === 'YES',
      language: item.LANGUAGE || '', channels: Number(item.CHANNELS) || 0}))
    .filter(item => item.url);
  const variants = [];
  for (let i = 0; i < all.length; i++) {
    if (!all[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const info = attributes(all[i]);
    // Audio-only entries are reached through their EXT-X-MEDIA group instead.
    if (!info.RESOLUTION && info.CODECS && !/avc|hvc|hev|dvh|av01|vp0?9/i.test(info.CODECS)) continue;
    let next = i + 1;
    while (next < all.length && (!all[next] || all[next].startsWith('#'))) next++;
    const url = mediaUrl(all[next], base);
    if (!url) continue;
    const [width, height] = (info.RESOLUTION || '0x0').split('x').map(Number);
    const tracks = audio.filter(item => item.group === info.AUDIO);
    const track = tracks.find(item => item.default) || tracks[0];
    variants.push({
      url,
      audioUrl: track?.url || null,
      audioGroup: track ? info.AUDIO : null,
      width: width || 0,
      height: height || 0,
      bandwidth: Number(info['AVERAGE-BANDWIDTH'] || info.BANDWIDTH) || 0,
      peakBandwidth: Number(info.BANDWIDTH) || 0,
      codecs: info.CODECS || '',
      fps: Number(info['FRAME-RATE']) || 0,
    });
  }
  // Some links point straight at a media playlist.
  if (!variants.length && all.some(line => line.startsWith('#EXTINF:'))) {
    variants.push({url: mediaUrl(base), audioUrl: null, audioGroup: null, width: 0, height: 0,
      bandwidth: 0, peakBandwidth: 0, codecs: '', fps: 0});
  }
  return {variants: variants.filter(item => item.url), audio};
}

function byteRange(value, previousEnd) {
  const [length, offset] = value.split('@').map(Number);
  const start = Number.isFinite(offset) ? offset : previousEnd;
  if (!(length > 0) || !(start >= 0)) throw new UnsupportedError('This stream uses an unsupported byte range.');
  return {start, end: start + length - 1};
}

/**
 * Parse a media playlist. Throws ProtectedError for any encryption and
 * UnsupportedError for live, discontinuous or non-fMP4 streams.
 */
export function parseMedia(text, base) {
  assertPlaylist(text);
  const segments = [];
  let init = null, duration = 0, segmentDuration = 0, range = null, lastRange = null, lastUrl = null;
  for (const line of lines(text)) {
    if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
      if (attributes(line).METHOD !== 'NONE') throw new ProtectedError();
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = attributes(line);
      const next = {url: mediaUrl(attrs.URI, base), range: attrs.BYTERANGE ? byteRange(attrs.BYTERANGE, 0) : null};
      if (!next.url) throw new UnsupportedError('This stream’s initialisation data is on an unexpected host.');
      if (init && JSON.stringify(init) !== JSON.stringify(next)) {
        throw new UnsupportedError('This video changes format part-way through, which isn’t supported yet.');
      }
      init = next;
    } else if (line === '#EXT-X-DISCONTINUITY') {
      throw new UnsupportedError('This stream has timeline breaks, which aren’t supported yet.');
    } else if (line.startsWith('#EXTINF:')) {
      segmentDuration = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const value = line.slice(17);
      range = {...byteRange(value, lastRange ? lastRange.end + 1 : 0), implicit: !value.includes('@')};
    } else if (line && !line.startsWith('#')) {
      const url = mediaUrl(line, base);
      if (!url) throw new UnsupportedError('This stream’s segments are on an unexpected host.');
      if (range?.implicit && lastUrl !== url) throw new UnsupportedError('This stream has an invalid byte range.');
      segments.push({url, range: range && {start: range.start, end: range.end}, duration: segmentDuration});
      duration += segmentDuration;
      lastRange = range;
      lastUrl = url;
      range = null;
      segmentDuration = 0;
    }
  }
  if (!/^#EXT-X-ENDLIST\b/m.test(text)) {
    throw new UnsupportedError('This is a live stream. Try again once the recording is published.');
  }
  if (!init) throw new UnsupportedError('This stream uses MPEG-TS segments, which Vimeo no longer serves and this extension doesn’t support.');
  if (!segments.length) throw new UnsupportedError('This playlist has no video segments.');
  return {init, segments, duration};
}
