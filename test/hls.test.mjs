import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {attributes, parseMaster, parseMedia, ProtectedError, UnsupportedError} from '../extension/lib/hls.mjs';

const fixture = name => readFileSync(new URL(`./fixtures/hls/${name}`, import.meta.url), 'utf8');
const BASE = 'https://vod-adaptive-ak.vimeocdn.com/exp=1999999999~acl=x/abc/v2/playlist/av/primary/playlist.m3u8';

test('attributes handles quoted commas', () => {
  assert.deepEqual(attributes('#EXT-X-STREAM-INF:BANDWIDTH=10,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=640x360'),
    {BANDWIDTH: '10', CODECS: 'avc1.64001f,mp4a.40.2', RESOLUTION: '640x360'});
});

test('parseMaster pairs each variant with its audio rendition', () => {
  const {variants, audio} = parseMaster(fixture('master.m3u8'), BASE);
  assert.equal(audio.length, 1);
  assert.equal(variants.length, 2);
  const [big, small] = variants;
  assert.equal(big.height, 108);
  assert.equal(big.width, 192);
  assert.equal(big.bandwidth, 121532);
  assert.equal(big.fps, 24);
  assert.match(big.codecs, /avc1/);
  assert.equal(big.url, 'https://vod-adaptive-ak.vimeocdn.com/exp=1999999999~acl=x/abc/v2/playlist/av/primary/stream_0/index.m3u8?st=video');
  assert.equal(big.audioUrl, 'https://vod-adaptive-ak.vimeocdn.com/exp=1999999999~acl=x/abc/v2/playlist/av/primary/stream_1/index.m3u8?st=audio');
  assert.equal(small.height, 72);
});

test('parseMaster drops variants on foreign hosts and audio-only entries', () => {
  const text = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360,CODECS="avc1.64001e"
https://evil.example/360.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="mp4a.40.2"
audio.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=1280x720,CODECS="avc1.64001f"
720.m3u8`;
  const {variants} = parseMaster(text, BASE);
  assert.deepEqual(variants.map(item => item.height), [720]);
});

test('parseMaster accepts a bare media playlist', () => {
  const {variants} = parseMaster(fixture('stream_0/index.m3u8'), BASE);
  assert.equal(variants.length, 1);
  assert.equal(variants[0].url, BASE);
});

test('parseMaster rejects non-playlists', () => {
  assert.throws(() => parseMaster('<html>Sorry</html>', BASE), UnsupportedError);
});

test('parseMedia reads init, segments and duration', () => {
  const media = parseMedia(fixture('stream_1/index.m3u8'), BASE);
  assert.match(media.init.url, /init_1\.mp4$/);
  assert.equal(media.segments.length, 3);
  assert.ok(Math.abs(media.duration - 5.021333) < 1e-6);
});

test('parseMedia refuses any encrypted or DRM stream', () => {
  for (const key of [
    '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://drm",KEYFORMAT="com.apple.streamingkeydelivery"',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES-CTR,URI="data:x"',
  ]) {
    const text = `#EXTM3U\n${key}\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nseg.m4s\n#EXT-X-ENDLIST`;
    assert.throws(() => parseMedia(text, BASE), ProtectedError);
  }
  const clear = '#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nseg.m4s\n#EXT-X-ENDLIST';
  assert.equal(parseMedia(clear, BASE).segments.length, 1);
});

test('parseMedia refuses live, discontinuous and MPEG-TS streams', () => {
  const live = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nseg.m4s';
  assert.throws(() => parseMedia(live, BASE), /live stream/);
  const broken = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\na.m4s\n#EXT-X-DISCONTINUITY\n#EXTINF:6,\nb.m4s\n#EXT-X-ENDLIST';
  assert.throws(() => parseMedia(broken, BASE), /timeline breaks/);
  const ts = '#EXTM3U\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST';
  assert.throws(() => parseMedia(ts, BASE), /MPEG-TS/);
});

test('parseMedia resolves byte ranges, including implicit offsets', () => {
  const text = `#EXTM3U
#EXT-X-MAP:URI="file.mp4",BYTERANGE="100@0"
#EXTINF:6,
#EXT-X-BYTERANGE:500@100
file.mp4
#EXTINF:6,
#EXT-X-BYTERANGE:300
file.mp4
#EXT-X-ENDLIST`;
  const media = parseMedia(text, BASE);
  assert.deepEqual(media.init.range, {start: 0, end: 99});
  assert.deepEqual(media.segments.map(item => item.range), [{start: 100, end: 599}, {start: 600, end: 899}]);
});

test('parseMedia rejects segments on foreign hosts', () => {
  const text = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nhttps://evil.example/seg.m4s\n#EXT-X-ENDLIST';
  assert.throws(() => parseMedia(text, BASE), /unexpected host/);
});
