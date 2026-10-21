// Runs the real page scanner against a tiny stand-in DOM, so changes to what
// it extracts (and what it keeps from a player's config) are caught here.
import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {scanPage} from '../extension/lib/detector.mjs';
import {parseConfig} from '../extension/lib/vimeo.mjs';

const saved = {};
for (const name of ['location', 'document', 'window']) saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
afterEach(() => {
  for (const [name, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

function element(localName, attributes = {}, text = '') {
  return {
    localName, textContent: text, shadowRoot: null,
    attributes: Object.entries(attributes).map(([name, value]) => ({name, value})),
    getAttribute: name => attributes[name] ?? null,
  };
}

function page({url, title = 'Page', elements = [], scripts = []}) {
  const top = {};
  Object.defineProperty(globalThis, 'location', {value: new URL(url), configurable: true, writable: true});
  Object.defineProperty(globalThis, 'window', {value: top, configurable: true, writable: true});
  top.top = top;
  Object.defineProperty(globalThis, 'document', {configurable: true, writable: true, value: {
    title,
    scripts: scripts.map(text => ({textContent: text})),
    querySelectorAll: () => elements,
  }});
}

test('in a player frame, the scanner keeps the config fields the extension needs, refresh URL included', () => {
  const config = {
    video: {id: 1202195955, title: 'One workspace'},
    request: {
      files: {hls: {default_cdn: 'a', cdns: {a: {avc_url: 'https://vod-adaptive-ak.vimeocdn.com/x/playlist.m3u8'}}}},
      text_tracks: [],
      config_refresh_url: 'https://player.vimeo.com/video/1202195955/config/request?expires=3600&signature=s',
      drm: {certificate: 'large and unneeded'},
    },
  };
  page({url: 'https://player.vimeo.com/video/1202195955?h=abcdef1234', scripts: [`window.playerConfig = ${JSON.stringify(config)}; boot();`]});
  const result = scanPage();
  assert.equal(result.configs.length, 1);
  const [kept] = result.configs;
  assert.equal(kept.request.drm, undefined, 'DRM details are dropped');
  assert.equal(parseConfig(kept).refreshUrl, config.request.config_refresh_url);
  assert.ok(result.items.some(item => item.url.includes('/video/1202195955') && item.source === 'embed'));
});

test('on an ordinary page, the scanner finds embeds, lazy embeds and links but no configs', () => {
  page({
    url: 'https://example.com/lesson',
    elements: [
      element('iframe', {src: 'https://player.vimeo.com/video/111111?h=abcdef1234', title: 'Intro'}),
      element('lite-vimeo', {videoid: '222222'}),
      element('a', {href: 'https://vimeo.com/333333'}, 'Watch the next one'),
      element('div', {'data-config': '{"url":"https:\\/\\/vimeo.com\\/444444"}'}),
      element('a', {href: 'https://evil.example/vimeo.com/555555'}),
    ],
    scripts: ['window.playerConfig = {"video":{"id":999}}'],
  });
  const result = scanPage();
  assert.deepEqual(result.configs, [], 'playerConfig is only trusted inside Vimeo player frames');
  const found = Object.fromEntries(result.items.map(item => [item.url, item]));
  assert.equal(found['https://player.vimeo.com/video/111111?h=abcdef1234'].source, 'embed');
  assert.equal(found['https://player.vimeo.com/video/111111?h=abcdef1234'].title, 'Intro');
  assert.equal(found['https://player.vimeo.com/video/222222'].source, 'embed');
  assert.equal(found['https://vimeo.com/333333'].source, 'link');
  assert.equal(found['https://vimeo.com/333333'].title, 'Watch the next one');
  assert.equal(found['https://vimeo.com/444444'].source, 'data');
  assert.ok(!result.items.some(item => item.url.includes('evil.example')));
  assert.equal(result.top, true);
});

test('the scanner ignores absurdly long attribute values', () => {
  page({url: 'https://example.com/', elements: [element('iframe', {src: `https://player.vimeo.com/video/123456?x=${'a'.repeat(5000)}`})]});
  assert.equal(scanPage().items.length, 0);
});
