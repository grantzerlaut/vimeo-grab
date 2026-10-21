// Turning Vimeo's renditions into a short, sorted list of download choices.

const isAvc = codecs => /\bavc[13]\b|\bavc[13]\./.test(codecs || '');

/** Short quality label: 1080p, 4K, 720p60, Audio. */
export function qualityLabel(format) {
  if (format.audioOnly) return 'Audio';
  const height = format.height || 0;
  if (!height) return 'Original';
  const name = height >= 2160 ? '4K' : height >= 1440 && height < 1600 ? '1440p' : `${height}p`;
  return format.fps > 31 ? `${name}${Math.round(format.fps)}` : name;
}

/** Rough size in bytes from a bitrate and a duration, or 0 when unknown. */
export function estimateSize(format, duration) {
  if (format.size) return format.size;
  return format.bandwidth && duration ? Math.round(format.bandwidth * duration / 8) : 0;
}

/**
 * Build download choices from progressive files and a parsed master playlist.
 * One entry per resolution (H.264 and direct MP4 preferred), best first,
 * followed by an audio-only choice when the video has separate audio.
 */
export function buildFormats({progressive = [], master = null, duration = 0}) {
  const video = [
    ...progressive.map(item => ({...item, kind: 'mp4'})),
    ...(master?.variants || []).map(item => ({kind: 'hls', ...item})),
  ].map(item => ({...item, size: estimateSize(item, duration)}));
  const rank = item => (item.kind === 'mp4' ? 2 : 0) + (item.kind === 'mp4' || isAvc(item.codecs) ? 1 : 0);
  video.sort((a, b) => b.height - a.height || rank(b) - rank(a) || (b.bandwidth || 0) - (a.bandwidth || 0));
  const seen = new Set();
  const formats = [];
  for (const item of video) {
    const key = `${item.height || 0}:${item.fps > 31 ? 'hfr' : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    formats.push({...item, id: `${item.kind}-${item.height || 0}${item.fps > 31 ? 'hfr' : ''}`, label: qualityLabel(item)});
  }
  // Audio-only: the rendition paired with the best video variant.
  const bestWithAudio = (master?.variants || [])
    .filter(item => item.audioUrl)
    .sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth)[0];
  if (bestWithAudio) {
    formats.push({id: 'audio', kind: 'hls', audioOnly: true, url: null, audioUrl: bestWithAudio.audioUrl,
      audioGroup: bestWithAudio.audioGroup, height: 0, width: 0, bandwidth: 0, size: 0, label: 'Audio'});
  }
  return formats;
}

/**
 * Pick a format for a quality preference: 'best', 'smallest', 'audio', a
 * format id, or a height cap such as '1080' (highest at or below the cap,
 * otherwise the lowest available).
 */
export function chooseFormat(formats, preference = 'best') {
  const exact = formats.find(item => item.id === preference);
  if (exact) return exact;
  const video = formats.filter(item => !item.audioOnly);
  if (preference === 'audio') return formats.find(item => item.audioOnly) || null;
  if (!video.length) return formats[0] || null;
  if (preference === 'smallest') return video.at(-1);
  const cap = Number(preference);
  if (!cap) return video[0];
  return video.find(item => item.height && item.height <= cap) || video.at(-1);
}

/** Whether a stored format still matches the same rendition after a refresh. */
export function sameRendition(a, b) {
  if (!a || !b) return false;
  if (a.audioOnly || b.audioOnly) return Boolean(a.audioOnly && b.audioOnly);
  return a.kind === b.kind && a.height === b.height && (a.fps > 31) === (b.fps > 31);
}
