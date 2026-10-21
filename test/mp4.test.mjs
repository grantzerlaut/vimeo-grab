import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Mp4Remuxer, readBoxes, concatBytes} from '../extension/lib/mp4.mjs';
import {ProtectedError} from '../extension/lib/hls.mjs';
import {fixtureBytes, streamPayload, readMp4} from './helpers.mjs';

/** Remux the fixture stream in memory: video + audio, interleaved by segment. */
function remuxFixture({audio = true, metadata} = {}) {
  const inits = [fixtureBytes('stream_0/init_0.mp4')];
  if (audio) inits.push(fixtureBytes('stream_1/init_1.mp4'));
  const remuxer = new Mp4Remuxer(inits, metadata);
  const parts = [remuxer.header()];
  for (let i = 0; i < 3; i++) {
    parts.push(...remuxer.append(0, fixtureBytes(`stream_0/seg${i}.m4s`)));
    if (audio) parts.push(...remuxer.append(1, fixtureBytes(`stream_1/seg${i}.m4s`)));
  }
  const {sizePatch, moov} = remuxer.finish();
  const file = concatBytes([...parts, moov]);
  file.set(sizePatch.data, sizePatch.position);
  return file;
}

test('remuxed file is a regular MP4: ftyp, one mdat, moov, no fragments', () => {
  const file = remuxFixture();
  const top = readBoxes(file);
  assert.deepEqual(top.map(box => box.type), ['ftyp', 'mdat', 'moov']);
  assert.equal(top.at(-1).end, file.length);
  const moov = top.at(-1);
  const kids = readBoxes(file, moov.body, moov.end).map(box => box.type);
  assert.ok(!kids.includes('mvex'), 'no movie-extends box');
  assert.deepEqual(kids.filter(type => type === 'trak').length, 2);
});

test('sample tables point at exactly the original sample bytes', () => {
  const [video, audio] = readMp4(remuxFixture());
  assert.equal(video.handler, 'vide');
  assert.equal(audio.handler, 'soun');
  assert.equal(video.sampled, video.count);
  assert.equal(audio.sampled, audio.count);
  assert.ok(video.samples.equals(streamPayload('stream_0', 3)), 'video bytes match');
  assert.ok(audio.samples.equals(streamPayload('stream_1', 3)), 'audio bytes match');
  assert.equal(video.count, 120); // 5 s at 24 fps
  assert.ok(video.hasStss, 'keyframe table present for video');
  assert.ok(video.hasCtts, 'B-frame offsets preserved');
  assert.ok(!audio.hasStss, 'audio samples are all sync samples');
});

test('audio-only output uses the M4A brand', () => {
  const remuxer = new Mp4Remuxer([fixtureBytes('stream_1/init_1.mp4')]);
  const header = remuxer.header();
  assert.equal(String.fromCharCode(...header.subarray(8, 12)), 'M4A ');
});

test('metadata is written as iTunes-style tags', () => {
  const file = remuxFixture({metadata: {title: 'Ünïcode title', artist: 'Studio', comment: 'https://vimeo.com/1'}});
  const text = Buffer.from(file).toString('utf8');
  assert.ok(text.includes('Ünïcode title'));
  assert.ok(text.includes('Studio'));
});

test('encrypted inits and fragments are refused', () => {
  const init = fixtureBytes('stream_0/init_0.mp4');
  const at = Buffer.from(init).indexOf('avc1');
  const encrypted = init.slice();
  encrypted.set([0x65, 0x6e, 0x63, 0x76], at); // avc1 -> encv
  assert.throws(() => new Mp4Remuxer([encrypted]), ProtectedError);

  const segment = fixtureBytes('stream_0/seg0.m4s').slice();
  const trun = Buffer.from(segment).indexOf('trun');
  segment.set([0x73, 0x65, 0x6e, 0x63], trun); // trun -> senc
  const remuxer = new Mp4Remuxer([init]);
  remuxer.header();
  assert.throws(() => remuxer.append(0, segment), ProtectedError);
});

test('truncated segments are rejected instead of producing a broken file', () => {
  const remuxer = new Mp4Remuxer([fixtureBytes('stream_0/init_0.mp4')]);
  remuxer.header();
  const segment = fixtureBytes('stream_0/seg0.m4s');
  assert.throws(() => remuxer.append(0, segment.subarray(0, segment.length - 100)), /damaged|incomplete|outside/);
});

const ffprobe = spawnSync('ffprobe', ['-version']).status === 0;

test('ffmpeg decodes the remuxed file with correct streams and duration', {skip: !ffprobe && 'ffprobe not installed'}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'vimeo-grab-'));
  try {
    const file = join(dir, 'out.mp4');
    writeFileSync(file, remuxFixture({metadata: {title: 'Fixture'}}));
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:format_tags=title:stream=codec_type,nb_frames',
      '-of', 'json', file], {encoding: 'utf8'});
    assert.equal(probe.status, 0, probe.stderr);
    const info = JSON.parse(probe.stdout);
    assert.deepEqual(info.streams.map(stream => stream.codec_type), ['video', 'audio']);
    assert.equal(info.streams[0].nb_frames, '120');
    assert.ok(Math.abs(Number(info.format.duration) - 5) < 0.1, info.format.duration);
    assert.equal(info.format.tags.title, 'Fixture');
    const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], {encoding: 'utf8'});
    assert.equal(decode.status, 0);
    assert.equal(decode.stderr.trim(), '', 'decoder reported no errors');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
