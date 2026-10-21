import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildFormats, chooseFormat, qualityLabel, sameRendition} from '../extension/lib/formats.mjs';

const variant = (height, extra = {}) => ({url: `https://x.vimeocdn.com/${height}.m3u8`, audioUrl: 'https://x.vimeocdn.com/a.m3u8',
  audioGroup: 'audio-high', width: Math.round(height * 16 / 9), height, bandwidth: height * 2000, codecs: 'avc1.64001f,mp4a.40.2', fps: 24, ...extra});

test('buildFormats sorts best first, prefers H.264 and direct MP4, and adds audio', () => {
  const formats = buildFormats({
    duration: 100,
    progressive: [{url: 'https://vod-progressive.akamaized.net/720.mp4', height: 720, width: 1280, fps: 24, size: 5_000_000}],
    master: {variants: [variant(360), variant(1080, {codecs: 'hvc1.2.4.L123'}), variant(1080), variant(720), variant(2160)]},
  });
  assert.deepEqual(formats.map(item => item.label), ['4K', '1080p', '720p', '360p', 'Audio']);
  assert.match(formats[1].codecs, /avc1/);
  assert.equal(formats[2].kind, 'mp4');
  assert.equal(formats[2].size, 5_000_000);
  assert.equal(formats[3].size, 360 * 2000 * 100 / 8);
  assert.equal(formats.at(-1).audioOnly, true);
  assert.equal(new Set(formats.map(item => item.id)).size, formats.length);
});

test('buildFormats keeps high-frame-rate renditions separate', () => {
  const formats = buildFormats({master: {variants: [variant(1080, {fps: 60}), variant(1080)]}});
  assert.deepEqual(formats.map(item => item.label), ['1080p60', '1080p', 'Audio']);
});

test('buildFormats omits audio when there is no separate audio', () => {
  const formats = buildFormats({master: {variants: [variant(720, {audioUrl: null, audioGroup: null})]}});
  assert.deepEqual(formats.map(item => item.label), ['720p']);
});

test('chooseFormat honours caps, extremes, ids and audio', () => {
  const formats = buildFormats({master: {variants: [variant(2160), variant(1080), variant(720), variant(360)]}});
  assert.equal(chooseFormat(formats, 'best').height, 2160);
  assert.equal(chooseFormat(formats, '1080').height, 1080);
  assert.equal(chooseFormat(formats, '900').height, 720);
  assert.equal(chooseFormat(formats, '240').height, 360);
  assert.equal(chooseFormat(formats, 'smallest').height, 360);
  assert.equal(chooseFormat(formats, 'audio').audioOnly, true);
  assert.equal(chooseFormat(formats, 'hls-720').height, 720);
  assert.equal(chooseFormat([], 'best'), null);
});

test('qualityLabel and sameRendition', () => {
  assert.equal(qualityLabel({height: 1440}), '1440p');
  assert.equal(qualityLabel({height: 2160, fps: 50}), '4K50');
  assert.equal(qualityLabel({height: 0}), 'Original');
  assert.ok(sameRendition({kind: 'hls', height: 720, fps: 24}, {kind: 'hls', height: 720, fps: 25}));
  assert.ok(!sameRendition({kind: 'hls', height: 720, fps: 24}, {kind: 'hls', height: 720, fps: 60}));
  assert.ok(sameRendition({audioOnly: true}, {audioOnly: true, kind: 'hls'}));
});
