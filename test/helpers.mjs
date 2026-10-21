// Test helpers: a fake Vimeo CDN backed by the fixture files, and a small
// independent MP4 reader used to check the remuxer's sample tables.
import {readFileSync} from 'node:fs';
import {readBoxes} from '../extension/lib/mp4.mjs';

export const CDN = 'https://vod-adaptive-ak.vimeocdn.com/exp=1999999999~acl=x/abc/v2/playlist/av/primary/';
const FIXTURES = new URL('./fixtures/hls/', import.meta.url);

/** fetch() stand-in that serves test/fixtures/hls for any URL under CDN. */
export function fixtureFetch({delay = 0, fail = () => false, log = []} = {}) {
  return async (url, init = {}) => {
    log.push(url);
    if (delay) await new Promise(resolve => setTimeout(resolve, Math.random() * delay));
    init.signal?.throwIfAborted();
    const status = fail(url);
    if (status) return new Response('nope', {status});
    if (!url.startsWith(CDN)) return new Response('not found', {status: 404});
    const path = new URL(url).pathname.slice(new URL(CDN).pathname.length);
    try {
      const body = readFileSync(new URL(path, FIXTURES));
      return new Response(body, {status: 200, headers: {'content-length': String(body.length)}});
    } catch { return new Response('not found', {status: 404}); }
  };
}

export const fixtureBytes = path => new Uint8Array(readFileSync(new URL(path, FIXTURES)));

/** Concatenated mdat payloads of a stream's segments: its samples, in order. */
export function streamPayload(dir, count) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    const data = fixtureBytes(`${dir}/seg${i}.m4s`);
    for (const box of readBoxes(data)) if (box.type === 'mdat') parts.push(data.subarray(box.body, box.end));
  }
  return Buffer.concat(parts);
}

const u32 = (data, at) => new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(at);
const find = (data, box, type) => readBoxes(data, box.body, box.end).find(item => item.type === type);
const path = (data, box, ...types) => types.reduce((current, type) => current && find(data, current, type), box);

/** Read every track of a regular MP4 back into {handler, samples: Buffer, count, durations}. */
export function readMp4(data) {
  const top = readBoxes(data);
  const moov = top.find(box => box.type === 'moov');
  return readBoxes(data, moov.body, moov.end).filter(box => box.type === 'trak').map(trak => {
    const stbl = path(data, trak, 'mdia', 'minf', 'stbl');
    const hdlr = path(data, trak, 'mdia', 'hdlr');
    const stsz = find(data, stbl, 'stsz');
    const stsc = find(data, stbl, 'stsc');
    const stco = find(data, stbl, 'stco') || find(data, stbl, 'co64');
    const stts = find(data, stbl, 'stts');
    const count = u32(data, stsz.body + 8);
    const uniform = u32(data, stsz.body + 4);
    const sizes = Array.from({length: count}, (_, i) => uniform || u32(data, stsz.body + 12 + i * 4));
    const chunks = Array.from({length: u32(data, stco.body + 4)}, (_, i) => u32(data, stco.body + 8 + i * 4));
    const runs = Array.from({length: u32(data, stsc.body + 4)}, (_, i) => ({
      first: u32(data, stsc.body + 8 + i * 12), count: u32(data, stsc.body + 12 + i * 12)}));
    const parts = [];
    let sample = 0;
    chunks.forEach((offset, index) => {
      const run = runs.findLast(item => item.first <= index + 1);
      let at = offset;
      for (let i = 0; i < run.count; i++) {
        parts.push(data.subarray(at, at + sizes[sample]));
        at += sizes[sample++];
      }
    });
    let duration = 0;
    for (let i = 0, n = u32(data, stts.body + 4); i < n; i++) {
      duration += u32(data, stts.body + 8 + i * 8) * u32(data, stts.body + 12 + i * 8);
    }
    return {handler: String.fromCharCode(...data.subarray(hdlr.body + 8, hdlr.body + 12)), count, sampled: sample,
      samples: Buffer.concat(parts), duration, hasStss: Boolean(find(data, stbl, 'stss')), hasCtts: Boolean(find(data, stbl, 'ctts'))};
  });
}
