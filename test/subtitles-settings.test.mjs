import {test} from 'node:test';
import assert from 'node:assert/strict';
import {vttToSrt} from '../extension/lib/subtitles.mjs';
import {normalise, DEFAULTS} from '../extension/lib/settings.mjs';

test('vttToSrt converts cues, timestamps and simple styling', () => {
  const vtt = [
    'WEBVTT',
    'Kind: captions',
    '',
    'NOTE this is a comment',
    '',
    'STYLE',
    '::cue { color: lime }',
    '',
    'intro',
    '00:01.000 --> 00:04.500 align:start position:10%',
    '<v Narrator>Hello <i>there</i> &amp; welcome</v>',
    '',
    '00:00:05.25 --> 00:01:07.000',
    'Second line one',
    'Second line two',
    '',
    '01:02:03.004 --> 01:02:04.000',
    '<c.yellow>Late</c> <00:00:06.000>karaoke',
    '',
  ].join('\r\n');
  assert.equal(vttToSrt(vtt), [
    '1', '00:00:01,000 --> 00:00:04,500', 'Hello <i>there</i> & welcome', '',
    '2', '00:00:05,250 --> 00:01:07,000', 'Second line one', 'Second line two', '',
    '3', '01:02:03,004 --> 01:02:04,000', 'Late karaoke', '',
  ].join('\n'));
});

test('vttToSrt skips empty cues and tolerates a byte-order mark', () => {
  const srt = vttToSrt(`${String.fromCharCode(0xfeff)}WEBVTT\n\n00:00.000 --> 00:01.000\n\n\n00:02.000 --> 00:03.000\nOnly this\n`);
  assert.equal(srt, '1\n00:00:02,000 --> 00:00:03,000\nOnly this\n');
});

test('vttToSrt decodes entities once and keeps classed styling tags balanced', () => {
  const vtt = 'WEBVTT\n\n00:00.000 --> 00:01.000\nShow &amp;lt;b&amp;gt; &lt;tag&gt; it&#39;s &#x263A;\n\n' +
    '00:01.000 --> 00:02.000\n<i.loud>Shouting</i> <b.x>bold</b>\n';
  assert.equal(vttToSrt(vtt), '1\n00:00:00,000 --> 00:00:01,000\nShow &lt;b&gt; <tag> it\'s ' +
    String.fromCodePoint(0x263a) + '\n\n2\n00:00:01,000 --> 00:00:02,000\n<i>Shouting</i> <b>bold</b>\n');
});

test('vttToSrt starts a new cue on every timing line, even without a blank line', () => {
  const vtt = 'WEBVTT\n\n00:00.000 --> 00:01.000\nOne\n   \n00:02.000 --> 00:03.000\nTwo\n00:04.000 --> 00:05.000\nThree\n';
  const srt = vttToSrt(vtt);
  assert.equal((srt.match(/-->/g) || []).length, 3);
  assert.ok(!srt.includes('00:04.000'), 'timing lines never leak into text');
  assert.match(srt, /3\n00:00:04,000 --> 00:00:05,000\nThree\n$/);
});

test('vttToSrt keeps cue text after a whitespace-only line', () => {
  const srt = vttToSrt('WEBVTT\n\n00:00.000 --> 00:01.000\nFirst line\n \nSecond line\n\n00:02.000 --> 00:03.000\nNext\n');
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,000\nFirst line\nSecond line\n\n2\n/);
});

test('normalise fills defaults and clamps bad stored values', () => {
  assert.deepEqual(normalise({}), {...DEFAULTS});
  const odd = normalise({quality: 'ultra', concurrency: 99, subtitles: 'some', subtitleFormat: 'ass',
    folder: 42, template: '   ', saveAs: 'yes', metadata: 0});
  assert.equal(odd.quality, 'best');
  assert.equal(odd.concurrency, 3);
  assert.equal(odd.subtitles, 'none');
  assert.equal(odd.subtitleFormat, 'vtt');
  assert.equal(odd.folder, 'Vimeo');
  assert.equal(odd.template, DEFAULTS.template);
  assert.equal(odd.saveAs, false);
  assert.equal(odd.metadata, true);
  assert.equal(normalise({concurrency: 0}).concurrency, DEFAULTS.concurrency);
  assert.equal(normalise({concurrency: '1'}).concurrency, 1);
  assert.equal(normalise({folder: ''}).folder, '');
});
