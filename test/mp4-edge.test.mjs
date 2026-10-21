// Edge cases from real-world packagers, made by patching the fixture stream:
// late-starting audio, shared start offsets, overlapping fragments, negative
// composition offsets and odd sample flags.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Mp4Remuxer, readBoxes, concatBytes} from '../extension/lib/mp4.mjs';
import {fixtureBytes} from './helpers.mjs';

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'moof', 'traf', 'mvex']);
const view = data => new DataView(data.buffer, data.byteOffset, data.byteLength);

/** Every box of a type, at any depth: [{type, start, end, body}]. */
function find(data, type, start = 0, end = data.length) {
  const found = [];
  for (const box of readBoxes(data, start, end)) {
    if (box.type === type) found.push(box);
    if (CONTAINERS.has(box.type)) found.push(...find(data, type, box.body, box.end));
  }
  return found;
}

const segments = dir => [0, 1, 2].map(i => fixtureBytes(`${dir}/seg${i}.m4s`).slice());

function remux(inits, streams) {
  const remuxer = new Mp4Remuxer(inits);
  const parts = [remuxer.header()];
  for (let i = 0; i < streams[0].length; i++) {
    streams.forEach((stream, source) => parts.push(...remuxer.append(source, stream[i])));
  }
  const {sizePatch, moov} = remuxer.finish();
  const file = concatBytes([...parts, moov]);
  file.set(sizePatch.data, sizePatch.position);
  return file;
}

/** Per-track facts from a regular MP4: handler, edit list, ctts, stss, sample count, decode duration. */
function tracks(file) {
  return find(file, 'trak').map(trak => {
    const hdlr = find(file, 'hdlr', trak.body, trak.end)[0];
    const elst = find(file, 'elst', trak.body, trak.end)[0];
    const ctts = find(file, 'ctts', trak.body, trak.end)[0];
    const stts = find(file, 'stts', trak.body, trak.end)[0];
    const stsz = find(file, 'stsz', trak.body, trak.end)[0];
    const edits = [];
    if (elst) {
      for (let i = 0, n = view(file).getUint32(elst.body + 4); i < n; i++) {
        const at = elst.body + 8 + i * 12;
        edits.push({duration: view(file).getUint32(at), mediaTime: view(file).getInt32(at + 4)});
      }
    }
    const offsets = [];
    if (ctts) {
      for (let i = 0, n = view(file).getUint32(ctts.body + 4); i < n; i++) {
        const count = view(file).getUint32(ctts.body + 8 + i * 8), value = view(file).getInt32(ctts.body + 12 + i * 8);
        for (let k = 0; k < count; k++) offsets.push(value);
      }
    }
    let duration = 0;
    for (let i = 0, n = view(file).getUint32(stts.body + 4); i < n; i++) {
      duration += view(file).getUint32(stts.body + 8 + i * 8) * view(file).getUint32(stts.body + 12 + i * 8);
    }
    return {
      handler: String.fromCharCode(...file.subarray(hdlr.body + 8, hdlr.body + 12)),
      edits, offsets, duration, cttsVersion: ctts ? file[ctts.body] : null,
      hasStss: find(file, 'stss', trak.body, trak.end).length > 0,
      samples: view(file).getUint32(stsz.body + 8),
    };
  });
}

const mvhdDuration = file => view(file).getUint32(find(file, 'mvhd')[0].body + 16);
const shiftTfdt = (segment, delta) => {
  for (const tfdt of find(segment, 'tfdt')) {
    const at = tfdt.body + 4;
    if (segment[tfdt.body] === 1) view(segment).setBigUint64(at, view(segment).getBigUint64(at) + BigInt(delta));
    else view(segment).setUint32(at, view(segment).getUint32(at) + delta);
  }
};
const dropEdits = init => {
  const copy = init.slice();
  for (const edts of find(copy, 'edts')) copy.set([0x66, 0x72, 0x65, 0x65], edts.start + 4); // edts -> free
  return copy;
};

const VIDEO_INIT = fixtureBytes('stream_0/init_0.mp4');
const AUDIO_INIT = fixtureBytes('stream_1/init_1.mp4');
const baseline = tracks(remux([VIDEO_INIT, AUDIO_INIT], [segments('stream_0'), segments('stream_1')]));

test('audio that starts late with no edit list still plays, after an empty edit', () => {
  const audio = segments('stream_1');
  audio.forEach(segment => shiftTfdt(segment, 48000)); // +1 s at 48 kHz
  const file = remux([dropEdits(VIDEO_INIT), dropEdits(AUDIO_INIT)], [segments('stream_0'), audio]);
  const [, sound] = tracks(file);
  assert.equal(sound.edits.length, 2, 'empty edit + media edit');
  assert.equal(sound.edits[0].mediaTime, -1);
  assert.equal(sound.edits[0].duration, 1000);
  assert.equal(sound.edits[1].mediaTime, 0);
  assert.ok(sound.edits[1].duration > 4900, 'the media edit covers the audio');
  assert.equal(sound.samples, baseline[1].samples);
});

test('a start offset shared by every track is dropped, not kept as dead air', () => {
  const late = init => {
    const copy = init.slice();
    const elst = find(copy, 'elst')[0];
    const scale = view(copy).getUint32(find(copy, 'mvhd')[0].body + 12);
    const at = elst.body + 8; // First entry: the empty edit.
    view(copy).setUint32(at, view(copy).getUint32(at) + 10 * scale); // +10 s
    return copy;
  };
  const file = remux([late(VIDEO_INIT), late(AUDIO_INIT)], [segments('stream_0'), segments('stream_1')]);
  assert.ok(mvhdDuration(file) < 5500, `duration ${mvhdDuration(file)} ms`);
  const [video, sound] = tracks(file);
  // Same relative offset as the unshifted stream: video ~21 ms after audio.
  assert.deepEqual(video.edits.map(edit => edit.mediaTime), baseline[0].edits.map(edit => edit.mediaTime));
  assert.ok(Math.abs(video.edits[0].duration - baseline[0].edits[0].duration) <= 1);
  assert.deepEqual(sound.edits, baseline[1].edits);
});

test('overlapping audio fragments drop the repeated samples instead of drifting', () => {
  // Each fragment claims to start one AAC frame (1024 ticks) before the previous one ended.
  const audio = segments('stream_1');
  shiftTfdt(audio[1], -1024);
  shiftTfdt(audio[2], -2048);
  const [, sound] = tracks(remux([VIDEO_INIT, AUDIO_INIT], [segments('stream_0'), audio]));
  assert.equal(sound.samples, baseline[1].samples - 2);
  assert.equal(sound.duration, baseline[1].duration - 2 * 1024);
});

test('one tick of audio timestamp jitter loses no frames', () => {
  const audio = segments('stream_1');
  shiftTfdt(audio[1], -1);
  shiftTfdt(audio[2], -1);
  const [, sound] = tracks(remux([VIDEO_INIT, AUDIO_INIT], [segments('stream_0'), audio]));
  assert.equal(sound.samples, baseline[1].samples);
  assert.equal(sound.duration, baseline[1].duration - 1);
});

test('a timestamp reset (a jump back of seconds) keeps the rest of the audio', () => {
  const audio = segments('stream_1');
  shiftTfdt(audio[2], -3 * 48000);
  const [, sound] = tracks(remux([VIDEO_INIT, AUDIO_INIT], [segments('stream_0'), audio]));
  assert.equal(sound.samples, baseline[1].samples);
});

test('a stream whose timestamps start late, with an edit list that accounts for it, is rebased', () => {
  const lateEdit = (init, ticks) => {
    const copy = init.slice();
    const elst = find(copy, 'elst')[0];
    const at = elst.body + 8 + 12 + 4; // Second entry's media_time (after the empty edit).
    view(copy).setInt32(at, view(copy).getInt32(at) + ticks);
    return copy;
  };
  const video = segments('stream_0'), audio = segments('stream_1');
  video.forEach(segment => shiftTfdt(segment, 15360)); // +1 s at 15360 Hz
  audio.forEach(segment => shiftTfdt(segment, 48000)); // +1 s at 48 kHz
  const file = remux([lateEdit(VIDEO_INIT, 15360), lateEdit(AUDIO_INIT, 48000)], [video, audio]);
  const [videoTrack, sound] = tracks(file);
  assert.deepEqual(videoTrack.edits, baseline[0].edits);
  assert.deepEqual(sound.edits, baseline[1].edits);
  assert.ok(mvhdDuration(file) > 4900 && mvhdDuration(file) < 5500, `duration ${mvhdDuration(file)} ms`);
});

test('video with every sample flagged non-sync still gets keyframes', () => {
  const video = segments('stream_0');
  for (const segment of video) {
    // Mark everything non-sync; keyframes still say "depends on no other sample" (2).
    // The fixture uses both trun layouts: per-sample flags, and first-sample flags.
    for (const trun of find(segment, 'trun')) {
      const flags = view(segment).getUint32(trun.body) & 0xffffff;
      let at = trun.body + 8 + (flags & 1 ? 4 : 0);
      if (flags & 0x4) {
        view(segment).setUint32(at, view(segment).getUint32(at) | 0x10000);
        at += 4;
      }
      if (!(flags & 0x400)) continue;
      const fields = ((flags >> 8) & 1) + ((flags >> 9) & 1) + ((flags >> 10) & 1) + ((flags >> 11) & 1);
      const flagsAt = ((flags >> 8) & 1) + ((flags >> 9) & 1); // after duration and size, if present
      for (let i = 0, n = view(segment).getUint32(trun.body + 4); i < n; i++, at += fields * 4) {
        const field = at + flagsAt * 4;
        view(segment).setUint32(field, view(segment).getUint32(field) | 0x10000);
      }
    }
    for (const tfhd of find(segment, 'tfhd')) {
      const flags = view(segment).getUint32(tfhd.body) & 0xffffff;
      if (!(flags & 0x20)) continue;
      const at = tfhd.body + 8 + (flags & 1 ? 8 : 0) + (flags & 2 ? 4 : 0) + (flags & 8 ? 4 : 0) + (flags & 0x10 ? 4 : 0);
      view(segment).setUint32(at, view(segment).getUint32(at) | 0x10000);
    }
  }
  const keyframes = file => {
    const [stss] = find(file, 'stss');
    return Array.from({length: view(file).getUint32(stss.body + 4)}, (_, i) => view(file).getUint32(stss.body + 8 + i * 4));
  };
  const original = keyframes(remux([VIDEO_INIT, AUDIO_INIT], [segments('stream_0'), segments('stream_1')]));
  const patched = keyframes(remux([VIDEO_INIT, AUDIO_INIT], [video, segments('stream_1')]));
  assert.equal(original.length, 5, 'fixture has a keyframe every second');
  assert.deepEqual(patched, original, 'intra frames recovered as the sync samples');
});

test('negative composition offsets become a version-0 ctts with the same timing', () => {
  const video = segments('stream_0');
  for (const segment of video) {
    for (const trun of find(segment, 'trun')) {
      const flags = view(segment).getUint32(trun.body) & 0xffffff;
      assert.ok(flags & 0x800, 'fixture has composition offsets');
      segment[trun.body] = 1; // version 1: signed offsets
      const fields = ((flags >> 8) & 1) + ((flags >> 9) & 1) + ((flags >> 10) & 1) + 1;
      let at = trun.body + 8 + (flags & 1 ? 4 : 0) + (flags & 4 ? 4 : 0);
      for (let i = 0, n = view(segment).getUint32(trun.body + 4); i < n; i++, at += fields * 4) {
        const cto = at + (fields - 1) * 4;
        view(segment).setInt32(cto, view(segment).getInt32(cto) - 1024);
      }
    }
  }
  const [out] = tracks(remux([VIDEO_INIT, AUDIO_INIT], [video, segments('stream_1')]));
  const [base] = baseline;
  assert.equal(out.cttsVersion, 0);
  assert.ok(out.offsets.every(value => value >= 0));
  const media = track => track.edits.find(edit => edit.mediaTime >= 0).mediaTime;
  // Presentation times move exactly 1024 ticks earlier, as the patched input says.
  out.offsets.forEach((value, i) => assert.equal(value - media(out), base.offsets[i] - media(base) - 1024));
});

test('audio never gets a sync-sample table, even when fragments mark samples non-sync', () => {
  const audio = segments('stream_1');
  for (const segment of audio) {
    const tfhd = find(segment, 'tfhd')[0];
    const flags = view(segment).getUint32(tfhd.body) & 0xffffff;
    assert.equal(flags & 0x23, 0x20, 'fixture tfhd carries default flags at a fixed spot');
    const at = tfhd.body + 8 + (flags & 0x8 ? 4 : 0) + (flags & 0x10 ? 4 : 0);
    view(segment).setUint32(at, 0x01010000);
  }
  const [video, sound] = tracks(remux([VIDEO_INIT, AUDIO_INIT], [segments('stream_0'), audio]));
  assert.equal(sound.hasStss, false);
  assert.equal(video.hasStss, true);
});

test('a trun claiming millions of samples is rejected quickly', () => {
  const segment = segments('stream_0')[0];
  const trun = find(segment, 'trun')[0];
  view(segment).setUint32(trun.body, 0x000001); // only data_offset: no per-sample fields
  view(segment).setUint32(trun.body + 4, 0xffffffff);
  const remuxer = new Mp4Remuxer([VIDEO_INIT]);
  remuxer.header();
  assert.throws(() => remuxer.append(0, segment), /damaged/);
});

const ffprobe = spawnSync('ffprobe', ['-version']).status === 0;

test('ffprobe agrees: late audio has packets and starts one second in', {skip: !ffprobe && 'ffprobe not installed'}, () => {
  const audio = segments('stream_1');
  audio.forEach(segment => shiftTfdt(segment, 48000));
  const dir = mkdtempSync(join(tmpdir(), 'vimeo-grab-'));
  try {
    const path = join(dir, 'late.mp4');
    writeFileSync(path, remux([dropEdits(VIDEO_INIT), dropEdits(AUDIO_INIT)], [segments('stream_0'), audio]));
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-count_packets',
      '-show_entries', 'stream=nb_read_packets,start_time', '-of', 'json', path], {encoding: 'utf8'});
    const [stream] = JSON.parse(probe.stdout).streams;
    assert.ok(Number(stream.nb_read_packets) > 200, `${stream.nb_read_packets} audio packets`);
    assert.ok(Math.abs(Number(stream.start_time) - 1) < 0.05, `audio starts at ${stream.start_time}`);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
