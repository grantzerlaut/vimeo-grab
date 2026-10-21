import {test} from 'node:test';
import assert from 'node:assert/strict';
import {downloadHls, ordered} from '../extension/lib/stream.mjs';
import {fetchResource, HttpError} from '../extension/lib/fetch.mjs';
import {MemorySink} from '../extension/lib/sink.mjs';
import {parseMaster} from '../extension/lib/hls.mjs';
import {buildFormats} from '../extension/lib/formats.mjs';
import {CDN, fixtureFetch, readMp4, streamPayload} from './helpers.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('ordered() yields in input order despite out-of-order completion', async () => {
  const items = Array.from({length: 20}, (_, i) => i);
  let active = 0, peak = 0;
  const seen = [];
  for await (const value of ordered(items, async item => {
    active++; peak = Math.max(peak, active);
    await sleep(Math.random() * 10);
    active--;
    return item * 2;
  }, 4)) seen.push(value);
  assert.deepEqual(seen, items.map(item => item * 2));
  assert.ok(peak <= 4 && peak > 1, `peak concurrency ${peak}`);
});

test('ordered() rethrows the first failure and stops the rest', async () => {
  const started = [];
  const run = async () => {
    for await (const _ of ordered([0, 1, 2, 3, 4, 5, 6, 7], async (item, signal) => {
      started.push(item);
      if (item === 2) throw new Error('boom');
      await sleep(5);
      signal.throwIfAborted();
      return item;
    }, 2)) { /* consume */ }
  };
  await assert.rejects(run, /boom/);
  assert.ok(started.length < 8, 'did not start every item');
});

async function formatsFromFixture(fetcher) {
  const master = await fetchResource(`${CDN}master.m3u8`, {fetcher});
  return buildFormats({master: parseMaster(master.text, master.url), duration: 5});
}

test('downloadHls produces a complete MP4 from a Vimeo-style stream', async () => {
  const fetcher = fixtureFetch({delay: 5});
  const [best] = await formatsFromFixture(fetcher);
  const sink = new MemorySink();
  const progress = [];
  const result = await downloadHls(best, {sink, fetcher, concurrency: 3, metadata: {title: 'x'},
    onProgress: update => progress.push(update)});
  const file = new Uint8Array(await (await sink.close()).arrayBuffer());
  const [video, audio] = readMp4(file);
  assert.ok(video.samples.equals(streamPayload('stream_0', 3)));
  assert.ok(audio.samples.equals(streamPayload('stream_1', 3)));
  assert.equal(progress.at(-1).fraction, 1);
  assert.equal(progress.at(-1).segments, 6);
  assert.ok(result.bytes > 100_000);
  assert.ok(progress.every((item, i) => i === 0 || item.fraction >= progress[i - 1].fraction), 'progress never goes backwards');
});

test('downloadHls can save just the audio', async () => {
  const fetcher = fixtureFetch();
  const audioFormat = (await formatsFromFixture(fetcher)).find(item => item.audioOnly);
  const sink = new MemorySink();
  await downloadHls(audioFormat, {sink, fetcher});
  const tracks = readMp4(new Uint8Array(await (await sink.close()).arrayBuffer()));
  assert.deepEqual(tracks.map(track => track.handler), ['soun']);
});

test('downloadHls retries transient errors and gives up on expired links', async () => {
  let failures = 0;
  const flaky = fixtureFetch({fail: url => (url.includes('stream_0/seg1') && failures < 2 ? (failures++, 503) : 0)});
  const [best] = await formatsFromFixture(flaky);
  const sink = new MemorySink();
  await downloadHls(best, {sink, fetcher: flaky});
  assert.equal(failures, 2);
  const [video] = readMp4(new Uint8Array(await (await sink.close()).arrayBuffer()));
  assert.ok(video.samples.equals(streamPayload('stream_0', 3)), 'retried segment landed intact');

  const expired = fixtureFetch({fail: url => (url.includes('seg2') ? 403 : 0)});
  await assert.rejects(downloadHls(best, {sink: new MemorySink(), fetcher: expired}),
    error => error instanceof HttpError && error.expired);
});

test('downloadHls stops promptly when cancelled', async () => {
  const log = [];
  const fetcher = fixtureFetch({delay: 30, log});
  const [best] = await formatsFromFixture(fetcher);
  const controller = new AbortController();
  const run = downloadHls(best, {sink: new MemorySink(), fetcher, concurrency: 1, signal: controller.signal,
    onProgress: () => controller.abort(new DOMException('Cancelled', 'AbortError'))});
  await assert.rejects(run, {name: 'AbortError'});
  const segmentRequests = log.filter(url => url.includes('.m4s')).length;
  assert.ok(segmentRequests < 6, `stopped after ${segmentRequests} segment requests`);
});

test('fetchResource refuses non-Vimeo hosts before touching the network', async () => {
  let called = false;
  await assert.rejects(fetchResource('https://evil.example/x', {fetcher: async () => { called = true; }}), /non-Vimeo/);
  assert.equal(called, false);
});

test('fetchResource sends cookies only to vimeo.com and trims ignored ranges', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push(init.credentials);
    return new Response(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), {status: 200});
  };
  await fetchResource('https://player.vimeo.com/video/1/config', {fetcher});
  await fetchResource('https://player.vimeo.com/video/1/config', {fetcher, cookies: true});
  const bytes = await fetchResource('https://skyfire.vimeocdn.com/x.mp4', {fetcher, binary: true, cookies: true, range: {start: 2, end: 4}});
  assert.deepEqual(calls, ['omit', 'include', 'omit'], 'cookies are opt-in and never sent to the CDN');
  assert.deepEqual([...bytes], [2, 3, 4]);
});

test('fetchResource refuses a redirect off Vimeo', async () => {
  const fetcher = async () => {
    const response = new Response('{}', {status: 200});
    Object.defineProperty(response, 'url', {value: 'https://evil.example/landing'});
    return response;
  };
  await assert.rejects(fetchResource('https://player.vimeo.com/video/1/config', {fetcher}), /unexpected address/);
});

test('ordered() starts nothing when the signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('Cancelled', 'AbortError'));
  let live = 0;
  const run = async () => {
    for await (const _ of ordered([1, 2, 3], async (item, signal) => { if (!signal.aborted) live++; return item; }, 2, controller.signal)) { /* consume */ }
  };
  await assert.rejects(run, {name: 'AbortError'});
  assert.equal(live, 0);
});

test('fetchResource accepts compressed bodies whose Content-Length is the encoded size', async () => {
  const fetcher = async () => new Response(new Uint8Array(10), {status: 200,
    headers: {'content-length': '15', 'content-encoding': 'gzip'}});
  const data = await fetchResource('https://skyfire.vimeocdn.com/seg.m4s', {fetcher, binary: true, retries: 0});
  assert.equal(data.length, 10);
});

test('fetchResource rejects a 206 for the wrong range and counts only kept bytes', async () => {
  let counted = 0;
  const wrong = async () => new Response(new Uint8Array(3), {status: 206, headers: {'content-range': 'bytes 0-2/10'}});
  await assert.rejects(fetchResource('https://skyfire.vimeocdn.com/f.mp4',
    {fetcher: wrong, binary: true, retries: 0, range: {start: 5, end: 7}}), /wrong part/);
  const ignored = async () => new Response(new Uint8Array(1000).map((_, i) => i % 256), {status: 200});
  const data = await fetchResource('https://skyfire.vimeocdn.com/f.mp4',
    {fetcher: ignored, binary: true, range: {start: 500, end: 509}, onBytes: count => { counted += count; }});
  assert.deepEqual([...data], [244, 245, 246, 247, 248, 249, 250, 251, 252, 253]);
  assert.equal(counted, 10);
});

test('MemorySink enforces its size limit', async () => {
  const sink = new MemorySink(10);
  await sink.write(new Uint8Array(8));
  await assert.rejects(sink.write(new Uint8Array(8)), /too large/);
});
