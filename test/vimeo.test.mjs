import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {vimeoRef, mediaUrl, downloadUrl, configsFromText, parseConfig, secondsUntilExpiry} from '../extension/lib/vimeo.mjs';

const config = JSON.parse(readFileSync(new URL('./fixtures/config.json', import.meta.url), 'utf8'));

test('vimeoRef recognises the URL shapes Vimeo uses for videos', () => {
  const cases = {
    'https://vimeo.com/76979871': ['76979871', ''],
    'https://vimeo.com/76979871/': ['76979871', ''],
    'https://www.vimeo.com/76979871?share=copy': ['76979871', ''],
    'https://vimeo.com/76979871/a1b2c3d4e5': ['76979871', 'a1b2c3d4e5'],
    'https://player.vimeo.com/video/76979871': ['76979871', ''],
    'https://player.vimeo.com/video/76979871?h=A1B2C3D4E5&badge=0': ['76979871', 'a1b2c3d4e5'],
    'https://player.vimeo.com/video/76979871/config?h=a1b2c3d4e5&s=sig': ['76979871', 'a1b2c3d4e5'],
    '//player.vimeo.com/video/123': ['123', ''],
    'https://vimeo.com/channels/staffpicks/76979871': ['76979871', ''],
    'https://vimeo.com/groups/motion/videos/76979871': ['76979871', ''],
    'https://vimeo.com/showcase/1234567/video/76979871': ['76979871', ''],
    'https://vimeo.com/album/1234567/video/76979871': ['76979871', ''],
    'https://vimeo.com/manage/videos/76979871/a1b2c3d4e5': ['76979871', 'a1b2c3d4e5'],
  };
  for (const [url, [id, hash]] of Object.entries(cases)) {
    const ref = vimeoRef(url);
    assert.ok(ref, url);
    assert.equal(ref.id, id, url);
    assert.equal(ref.hash, hash, url);
    assert.equal(ref.playerUrl, `https://player.vimeo.com/video/${id}${hash ? '?h=' + hash : ''}`);
  }
});

test('vimeoRef ignores pages that are not a single video', () => {
  for (const url of [
    'https://vimeo.com/showcase/1234567',
    'https://vimeo.com/channels/1234567',
    'https://vimeo.com/event/1234567',
    'https://vimeo.com/user12345678',
    'https://vimeo.com/1234',
    'https://vimeo.com/upgrade',
    'https://player.vimeo.com/video/abc',
    'https://notvimeo.com/76979871',
    'https://vimeo.com.evil.example/76979871',
    'javascript:alert(1)//vimeo.com/76979871',
    'not a url at all',
  ]) assert.equal(vimeoRef(url), null, url);
});

test('vimeoRef ignores a malformed h= parameter', () => {
  assert.equal(vimeoRef('https://player.vimeo.com/video/1?h=<script>').hash, '');
});

test('host allowlists only admit Vimeo over https', () => {
  assert.ok(mediaUrl('https://vod-adaptive-ak.vimeocdn.com/x.m3u8'));
  assert.ok(mediaUrl('https://player.vimeo.com/video/1/config'));
  assert.ok(mediaUrl('seg.m4s', 'https://skyfire.vimeocdn.com/a/b.m3u8'));
  assert.equal(mediaUrl('http://player.vimeo.com/video/1'), null);
  assert.equal(mediaUrl('https://evil.example/vimeocdn.com'), null);
  assert.equal(mediaUrl('https://vimeocdn.com.evil.example/'), null);
  assert.equal(mediaUrl('https://vod-progressive.akamaized.net/x.mp4'), null);
  assert.ok(downloadUrl('https://vod-progressive.akamaized.net/x.mp4'));
});

test('configsFromText extracts player configs without evaluating code', () => {
  const html = `<script>var x = {"a":1}; window.playerConfig = ${JSON.stringify(config)}; doSomething();</script>
    <script>window.other = {"config": {"not": "vimeo"}};</script>`;
  const configs = configsFromText(html);
  assert.equal(configs.length, 1);
  assert.equal(configs[0].video.id, 123456789);
});

test('configsFromText copes with braces and quotes inside strings', () => {
  const tricky = {video: {id: 1, title: 'He said "}{" and left \\ {'}, request: {files: {}}};
  const [found] = configsFromText(`playerConfig = ${JSON.stringify(tricky)}`);
  assert.equal(found.video.title, tricky.video.title);
});

test('configsFromText finds config_url on vimeo.com clip pages', () => {
  const page = 'window.vimeo.clip_page_config = {"player":{"config_url":"https://player.vimeo.com/video/42/config?s=x"}};';
  assert.deepEqual(configsFromText(page), [{configUrl: 'https://player.vimeo.com/video/42/config?s=x'}]);
});

test('parseConfig keeps only safe URLs and normalises metadata', () => {
  const info = parseConfig(config);
  assert.equal(info.id, '123456789');
  assert.equal(info.hash, 'abcdef1234');
  assert.equal(info.title, 'A test video ~ with spaces');
  assert.equal(info.owner, 'Test Studio');
  assert.equal(info.duration, 5);
  assert.equal(info.thumbnail, 'https://i.vimeocdn.com/video/1-abc-d');
  assert.equal(info.live, false);
  // Default CDN first, H.264 playlists before the rest, foreign hosts dropped.
  assert.deepEqual(info.masters.map(url => new URL(url).host + (url.includes('omit=') ? ' avc' : '')), [
    'skyfire.vimeocdn.com avc', 'vod-adaptive-ak.vimeocdn.com avc', 'skyfire.vimeocdn.com', 'vod-adaptive-ak.vimeocdn.com',
  ]);
  assert.deepEqual(info.textTracks.map(track => [track.lang, track.url]), [
    ['en', 'https://captions.vimeo.com/captions/101.vtt?expires=1999999999&sig=0'],
    ['fr-CA', 'https://player.vimeo.com/texttrack/102.vtt?token=abc'],
  ]);
});

test('parseConfig keeps Vimeo’s signed refresh URL, but only on a Vimeo host', () => {
  const refresh = 'https://player.vimeo.com/video/123456789/config/request?atid=x&expires=3600&signature=abc';
  // Shaped like what the page scanner keeps from a player frame.
  const scanned = {video: config.video, request: {files: config.request.files, config_refresh_url: refresh}};
  assert.equal(parseConfig(scanned).refreshUrl, refresh);
  assert.equal(parseConfig({...scanned, request: {...scanned.request, config_refresh_url: 'https://evil.example/r'}}).refreshUrl, null);
  assert.equal(parseConfig(config).refreshUrl, null);
});

test('parseConfig flags live events and survives junk', () => {
  assert.equal(parseConfig({video: {id: 1, live_event: {status: 'started'}}}).live, true);
  assert.equal(parseConfig({video: {id: 1, live_event: {status: 'ended'}}}).live, false);
  const empty = parseConfig(null, {id: '9', title: 'From page'});
  assert.equal(empty.id, '9');
  assert.equal(empty.title, 'From page');
  assert.deepEqual(empty.masters, []);
});

test('secondsUntilExpiry reads Vimeo CDN signatures', () => {
  const now = 1_700_000_000_000;
  assert.equal(secondsUntilExpiry('https://a.vimeocdn.com/exp=1700000600~acl=x/y', now), 600);
  assert.equal(secondsUntilExpiry('https://a.vimeocdn.com/x?exp=1700000060', now), 60);
  assert.equal(secondsUntilExpiry('https://a.vimeocdn.com/plain', now), Infinity);
});
