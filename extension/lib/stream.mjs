// Download an HLS rendition and write it out as a single regular MP4.
import {fetchResource} from './fetch.mjs';
import {parseMedia} from './hls.mjs';
import {Mp4Remuxer, readBoxes} from './mp4.mjs';

function isWholeSegment(data) {
  try {
    const types = readBoxes(data).map(box => box.type);
    return types.includes('moof') && types.includes('mdat');
  } catch { return false; }
}

/**
 * Run `worker` over `items` with up to `limit` in flight, yielding results
 * strictly in input order. One failure stops new work and is rethrown.
 */
export async function* ordered(items, worker, limit, signal) {
  const controller = new AbortController();
  const stop = () => controller.abort(signal.reason);
  // An abort that already happened won't fire its event again.
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, {once: true});
  const pending = new Map();
  const start = index => {
    const promise = worker(items[index], controller.signal);
    promise.catch(() => {}); // Observed below, in order.
    pending.set(index, promise);
  };
  try {
    for (let i = 0; i < Math.min(limit, items.length); i++) start(i);
    for (let i = 0; i < items.length; i++) {
      controller.signal.throwIfAborted();
      const value = await pending.get(i);
      pending.delete(i);
      if (i + limit < items.length) start(i + limit);
      yield value;
    }
  } finally {
    controller.abort(new DOMException('Stopped', 'AbortError'));
    signal?.removeEventListener('abort', stop);
  }
}

/**
 * @param {{url?: string|null, audioUrl?: string|null, audioOnly?: boolean}} format
 * @param {{sink: {write(data: Uint8Array): Promise<void>, writeAt(position: number, data: Uint8Array): Promise<void>},
 *   signal?: AbortSignal, concurrency?: number, metadata?: object, fetcher?: typeof fetch,
 *   onProgress?: (progress: {fraction: number, bytes: number, segments: number, total: number}) => void}} options
 */
export async function downloadHls(format, {sink, signal, concurrency = 6, metadata, fetcher, onProgress = () => {}}) {
  const urls = format.audioOnly ? [format.audioUrl] : [format.url, format.audioUrl];
  const playlists = await Promise.all(urls.filter(Boolean).map(async url => {
    const response = await fetchResource(url, {signal, fetcher});
    return parseMedia(response.text, response.url);
  }));
  if (!playlists.length) throw new Error('This format has no stream to download.');

  let bytes = 0;
  const onBytes = count => { bytes += count; };
  const inits = await Promise.all(playlists.map(playlist =>
    fetchResource(playlist.init.url, {signal, range: playlist.init.range, binary: true, fetcher})));
  const remuxer = new Mp4Remuxer(inits, metadata);
  await sink.write(remuxer.header());

  // Interleave audio and video by time so the output plays smoothly.
  const work = [];
  playlists.forEach((playlist, source) => {
    let time = 0;
    for (const segment of playlist.segments) {
      work.push({segment, source, time});
      time += segment.duration;
    }
  });
  work.sort((a, b) => a.time - b.time || a.source - b.source);
  const totalDuration = playlists.reduce((total, playlist) => total + playlist.duration, 0) || work.length;

  let done = 0, doneDuration = 0;
  const fetchSegment = async (item, innerSignal) => {
    // A body cut short without a Content-Length looks complete to fetch;
    // check the boxes and fetch again rather than fail the whole video.
    for (let attempt = 0; ; attempt++) {
      const data = await fetchResource(item.segment.url,
        {signal: innerSignal, range: item.segment.range, binary: true, retries: 5, onBytes, fetcher});
      if (isWholeSegment(data) || attempt >= 2) return data;
      onBytes(-data.length);
    }
  };
  for await (const data of ordered(work, fetchSegment, concurrency, signal)) {
    const item = work[done];
    for (const chunk of remuxer.append(item.source, data, item.segment.range?.start ?? 0)) await sink.write(chunk);
    done++;
    doneDuration += item.segment.duration || 1;
    onProgress({fraction: Math.min(1, doneDuration / totalDuration), bytes, segments: done, total: work.length});
  }
  signal?.throwIfAborted();
  const {sizePatch, moov} = remuxer.finish();
  await sink.writeAt(sizePatch.position, sizePatch.data);
  await sink.write(moov);
  return {bytes};
}
