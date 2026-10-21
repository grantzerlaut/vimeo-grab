// Network access for the extension. Only Vimeo hosts are reachable (redirects
// included), cookies are sent only when asked for and only to vimeo.com (for
// private videos you can already watch), and slow-but-alive transfers are not
// killed by a fixed timeout.
import {mediaUrl, usesCookies} from './vimeo.mjs';

export class HttpError extends Error {
  constructor(status, url) {
    super(httpMessage(status));
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.permanent = [400, 401, 403, 404, 410, 451].includes(status);
    this.expired = status === 403 || status === 410;
  }
}

function httpMessage(status) {
  if (status === 401) return 'This video is private. Sign in to Vimeo, or open it on the page, then rescan.';
  if (status === 403) return 'Vimeo refused access. The link may have expired, or the video only plays on its own site. Rescan the page and try again.';
  if (status === 404 || status === 410) return 'Vimeo couldn’t find this video. It may have been removed or made private.';
  if (status === 429) return 'Vimeo is rate-limiting requests. Wait a minute and try again.';
  return `Vimeo returned an error (HTTP ${status}). Try again in a moment.`;
}

const IDLE_TIMEOUT = 30_000;
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, {once: true});
});

/**
 * Fetch a Vimeo resource as text (default) or bytes.
 * @param {string} url
 * @param {{signal?: AbortSignal, range?: {start: number, end: number}, binary?: boolean, cookies?: boolean,
 *   retries?: number, onBytes?: (count: number) => void, fetcher?: typeof fetch}} options
 */
export async function fetchResource(url, {signal, range, binary = false, cookies = false, retries = 3, onBytes, fetcher = fetch} = {}) {
  const safe = mediaUrl(url);
  if (!safe) throw new Error('Blocked a request to a non-Vimeo address.');
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, {once: true});
    let timer;
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error('The connection to Vimeo stalled.')), IDLE_TIMEOUT);
    };
    try {
      resetTimer();
      const response = await fetcher(safe, {
        credentials: cookies && usesCookies(safe) ? 'include' : 'omit',
        signal: controller.signal,
        headers: range ? {Range: `bytes=${range.start}-${range.end}`} : {},
      });
      if (response.url && !mediaUrl(response.url)) {
        const error = new Error('Vimeo redirected to an unexpected address, so the request was stopped.');
        error.permanent = true;
        throw error;
      }
      if (!response.ok) throw new HttpError(response.status, safe);
      if (!binary) {
        const text = await response.text();
        return {text, url: response.url || safe};
      }
      return await readBody(response, range, resetTimer, onBytes);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError');
      if (attempt >= retries || error.permanent) throw error;
      const wait = error.status === 429 ? 5000 * (attempt + 1) : 400 * 2 ** attempt + Math.random() * 250;
      await sleep(wait, signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}

async function readBody(response, range, resetTimer, onBytes) {
  const wanted = range ? range.end - range.start + 1 : null;
  if (range && response.status === 206) {
    const start = Number(/bytes\s+(\d+)-/.exec(response.headers.get('content-range') || '')?.[1]);
    if (Number.isFinite(start) && start !== range.start) throw new Error('Vimeo sent the wrong part of the file. Retrying…');
  }
  // A server that ignores Range sends the whole file: drop what comes before
  // the part we asked for as it streams in, and stop once we have it.
  let skip = range && response.status === 200 ? range.start : 0;
  // Content-Length counts compressed bytes when the body is encoded.
  const encoded = !/^(identity)?$/i.test(response.headers.get('content-encoding') || '');
  const declared = encoded ? 0 : Number(response.headers.get('content-length')) || 0;
  const chunks = [];
  let kept = 0;
  const reader = response.body.getReader();
  try {
    while (wanted == null || kept < wanted) {
      const {done, value} = await reader.read();
      if (done) break;
      resetTimer();
      let chunk = value;
      if (skip) {
        const drop = Math.min(skip, chunk.length);
        skip -= drop;
        chunk = chunk.subarray(drop);
      }
      if (wanted != null && kept + chunk.length > wanted) chunk = chunk.subarray(0, wanted - kept);
      if (!chunk.length) continue;
      chunks.push(chunk);
      kept += chunk.length;
      onBytes?.(chunk.length);
    }
  } catch (error) {
    onBytes?.(-kept); // This attempt's bytes don't count if it's retried.
    throw error;
  } finally {
    if (wanted != null && kept >= wanted) reader.cancel().catch(() => {});
    else reader.releaseLock();
  }
  const short = wanted != null ? kept < wanted : declared && kept < declared;
  if (short) {
    onBytes?.(-kept);
    throw new Error('The download was cut off. Retrying…');
  }
  return concat(chunks, kept);
}

function concat(chunks, length) {
  if (chunks.length === 1 && chunks[0].byteOffset === 0 && chunks[0].length === chunks[0].buffer.byteLength) return chunks[0];
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}
