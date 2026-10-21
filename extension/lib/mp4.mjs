// Fragmented MP4 (HLS/CMAF) → regular MP4, without decoding or re-encoding.
//
// Streaming players receive video as an init segment (moov with empty sample
// tables) plus many moof+mdat fragments. Video editors and some players handle
// that poorly, so this remuxer copies the sample bytes into one mdat and
// rebuilds complete sample tables (stts/ctts/stss/stsc/stsz/stco) in a moov
// written at the end. Memory use stays small: only the tables are kept.
//
// Spec: ISO/IEC 14496-12 (ISO base media file format).
import {ProtectedError, UnsupportedError} from './hls.mjs';

const MAC_EPOCH_OFFSET = 2082844800; // Seconds between 1904-01-01 and 1970-01-01.
const MAX_SEGMENT_SAMPLES = 1_000_000; // A few seconds of media is a few hundred samples.
const textEncoder = new TextEncoder();

// ---------------------------------------------------------------- reading

const dv = data => new DataView(data.buffer, data.byteOffset, data.byteLength);
const u32 = (data, at) => dv(data).getUint32(at);
const u64 = (data, at) => Number(dv(data).getBigUint64(at));
const fourcc = (data, at) => String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);

/** Top-level boxes between `start` and `end`: [{type, start, end, body}]. */
export function readBoxes(data, start = 0, end = data.length) {
  const boxes = [];
  for (let at = start; at < end;) {
    if (at + 8 > end) throw new UnsupportedError('A video segment ended unexpectedly.');
    let size = u32(data, at), header = 8;
    const type = fourcc(data, at + 4);
    if (size === 1) {
      if (at + 16 > end) throw new UnsupportedError('A video segment ended unexpectedly.');
      size = u64(data, at + 8);
      header = 16;
    } else if (size === 0) size = end - at;
    if (type === 'uuid') header += 16;
    if (size < header || at + size > end) throw new UnsupportedError('A video segment is damaged or incomplete.');
    boxes.push({type, start: at, end: at + size, body: at + header});
    at += size;
  }
  return boxes;
}

const children = (data, box) => readBoxes(data, box.body, box.end);
const child = (data, box, type) => children(data, box).find(item => item.type === type);
const slice = (data, box) => data.slice(box.start, box.end);

function required(box, what) {
  if (!box) throw new UnsupportedError(`This stream is missing ${what}.`);
  return box;
}

// ---------------------------------------------------------------- writing

class Writer {
  constructor(size = 256) { this.bytes = new Uint8Array(size); this.length = 0; }
  reserve(count) {
    if (this.length + count <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + count) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
  }
  u8(value) { this.reserve(1); this.bytes[this.length++] = value; return this; }
  u16(value) { this.reserve(2); dv(this.bytes).setUint16(this.length, value); this.length += 2; return this; }
  u32(value) { this.reserve(4); dv(this.bytes).setUint32(this.length, value >>> 0); this.length += 4; return this; }
  i32(value) { this.reserve(4); dv(this.bytes).setInt32(this.length, value); this.length += 4; return this; }
  u64(value) { this.reserve(8); dv(this.bytes).setBigUint64(this.length, BigInt(value)); this.length += 8; return this; }
  str(value) { return this.raw(textEncoder.encode(value)); }
  raw(data) { this.reserve(data.length); this.bytes.set(data, this.length); this.length += data.length; return this; }
  done() { return this.bytes.slice(0, this.length); }
}

function box(type, ...parts) {
  const typeBytes = typeof type === 'string' ? textEncoder.encode(type) : type;
  const size = 8 + parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Writer(size).u32(size).raw(typeBytes);
  for (const part of parts) out.raw(part);
  return out.done();
}

const fullBox = (type, version, flags, body) =>
  box(type, new Writer(4).u32((version << 24) | flags).done(), body);

// ---------------------------------------------------------------- tables

class List {
  constructor(Type = Uint32Array) { this.Type = Type; this.items = new Type(1024); this.length = 0; }
  push(value) {
    if (this.length === this.items.length) {
      const next = new this.Type(this.items.length * 2);
      next.set(this.items);
      this.items = next;
    }
    this.items[this.length++] = value;
  }
  get last() { return this.items[this.length - 1]; }
  set last(value) { this.items[this.length - 1] = value; }
  forEach(fn) { for (let i = 0; i < this.length; i++) fn(this.items[i], i); }
}

/** Run-length encode a list into [[count, value], …]. */
function runs(list) {
  const out = [];
  list.forEach(value => {
    const tail = out.at(-1);
    if (tail && tail[1] === value) tail[0]++;
    else out.push([1, value]);
  });
  return out;
}

// ---------------------------------------------------------------- init

function headerTimes(data, item) {
  const version = data[item.body];
  const at = item.body + 4;
  return version === 1
    ? {version, created: u64(data, at), modified: u64(data, at + 8), next: at + 16}
    : {version, created: u32(data, at), modified: u32(data, at + 4), next: at + 8};
}

function parseTrack(data, trak, trexById, movieScale) {
  const tkhd = required(child(data, trak, 'tkhd'), 'a track header');
  const times = headerTimes(data, tkhd);
  const sourceId = u32(data, times.next);
  // Everything after track_ID, reserved and duration (layer, volume, matrix, size).
  const tkhdTail = data.slice(times.next + (times.version === 1 ? 16 : 12), tkhd.end);
  const mdia = required(child(data, trak, 'mdia'), 'media information');
  const mdhd = required(child(data, mdia, 'mdhd'), 'a media header');
  const mdhdTimes = headerTimes(data, mdhd);
  const timescale = u32(data, mdhdTimes.next);
  const language = data.slice(mdhdTimes.next + (mdhdTimes.version === 1 ? 12 : 8), mdhd.end);
  const hdlr = required(child(data, mdia, 'hdlr'), 'a handler');
  const handler = fourcc(data, hdlr.body + 8);
  const minf = required(child(data, mdia, 'minf'), 'media details');
  const minfKids = children(data, minf);
  const stbl = required(minfKids.find(item => item.type === 'stbl'), 'a sample table');
  const stsd = required(child(data, stbl, 'stsd'), 'a sample description');
  const entries = readBoxes(data, stsd.body + 8, stsd.end);
  if (entries.some(entry => /^enc[avts]$/.test(entry.type))) throw new ProtectedError();
  if (!timescale) throw new UnsupportedError('This stream has an invalid timescale.');
  const edts = child(data, trak, 'edts');
  const elst = edts && child(data, edts, 'elst');
  const edits = [];
  if (elst) {
    const version = data[elst.body];
    const count = u32(data, elst.body + 4);
    for (let i = 0, at = elst.body + 8; i < count; i++, at += version === 1 ? 20 : 12) {
      const duration = version === 1 ? u64(data, at) : u32(data, at);
      const mediaTime = version === 1 ? Number(dv(data).getBigInt64(at + 8)) : dv(data).getInt32(at + 4);
      const rate = dv(data).getInt16(at + (version === 1 ? 16 : 8));
      edits.push({duration, mediaTime, rate});
    }
  }
  const trex = trexById.get(sourceId) || {sampleDescription: 1, duration: 0, size: 0, flags: 0};
  return {
    sourceId, handler, timescale, sourceMovieScale: movieScale, trex, edits,
    tkhdCreated: times.created, tkhdModified: times.modified, tkhdTail,
    language, codec: entries[0]?.type || '',
    hdlr: slice(data, hdlr),
    minfHeaders: minfKids.filter(item => item.type !== 'stbl').map(item => slice(data, item)),
    stsd: slice(data, stsd),
    // Sample tables, filled in as fragments arrive.
    sizes: new List(), durations: new List(), offsets: new List(Int32Array), syncs: new List(),
    independent: new List(), segmentStarts: new List(),
    chunkOffsets: new List(Float64Array), chunkSamples: new List(), chunkDescriptions: new List(),
    samples: 0, nonSync: false, minOffset: 0, hasOffsets: false, shift: 0,
    firstDecodeTime: null, nextDecodeTime: null, leadingGap: 0,
    outputTime: 0, presentationEnd: 0,
  };
}

/** Parse an fMP4 init segment into its tracks (encrypted tracks throw). */
export function parseInit(data) {
  const top = readBoxes(data);
  const moov = required(top.find(item => item.type === 'moov'), 'its movie header');
  const kids = children(data, moov);
  if (kids.some(item => item.type === 'pssh')) throw new ProtectedError();
  const mvhd = required(kids.find(item => item.type === 'mvhd'), 'a movie header');
  const times = headerTimes(data, mvhd);
  const movieScale = u32(data, times.next) || 1000;
  const trexById = new Map();
  const mvex = kids.find(item => item.type === 'mvex');
  for (const trex of mvex ? children(data, mvex).filter(item => item.type === 'trex') : []) {
    const at = trex.body + 4;
    trexById.set(u32(data, at), {sampleDescription: u32(data, at + 4), duration: u32(data, at + 8),
      size: u32(data, at + 12), flags: u32(data, at + 16)});
  }
  const tracks = kids.filter(item => item.type === 'trak').map(trak => parseTrack(data, trak, trexById, movieScale));
  if (!tracks.length) throw new UnsupportedError('This stream has no tracks.');
  return {movieScale, tracks};
}

// ---------------------------------------------------------------- remuxer

export class Mp4Remuxer {
  /**
   * @param {Uint8Array[]} inits One init segment per input stream (e.g. video, audio).
   * @param {{title?: string, artist?: string, comment?: string, tool?: string}} [metadata]
   */
  constructor(inits, metadata = {}) {
    this.sources = inits.map(parseInit);
    // Inputs can disagree (Vimeo: 24 for video, 48000 for audio); 1 ms is
    // precise enough for edit lists and what most muxers write.
    this.movieScale = 1000;
    this.tracks = [];
    for (const source of this.sources) {
      source.byId = new Map();
      for (const track of source.tracks) {
        track.id = this.tracks.length + 1;
        source.byId.set(track.sourceId, track);
        this.tracks.push(track);
      }
    }
    this.metadata = metadata;
    this.audioOnly = this.tracks.every(track => track.handler === 'soun');
    this.position = 0;
    this.mdatStart = 0;
  }

  /** ftyp plus a 64-bit mdat header whose size is patched by finish(). */
  header() {
    const avc = this.tracks.some(track => /^avc[13]$/.test(track.codec));
    const brands = this.audioOnly ? ['M4A ', 'isom', 'iso2', 'mp41'] : ['isom', 'iso2', ...(avc ? ['avc1'] : []), 'mp41'];
    const ftyp = box('ftyp', new Writer().str(this.audioOnly ? 'M4A ' : 'isom').u32(512).str(brands.join('')).done());
    const mdat = new Writer(16).u32(1).str('mdat').u64(0).done();
    this.mdatStart = ftyp.length;
    this.position = ftyp.length + mdat.length;
    return concatBytes([ftyp, mdat]);
  }

  /**
   * Take one media segment from input `source` and return the byte ranges to
   * append to the output, in order. Sample tables are updated as a side effect.
   * `fileOffset` is where `data` starts in its source file (for byte-range
   * segments whose fragments use absolute offsets).
   */
  append(source, data, fileOffset = 0) {
    const input = this.sources[source];
    if (!input) throw new Error(`Unknown input stream ${source}.`);
    if (!this.position) throw new Error('Call header() before append().');
    const out = [];
    const top = readBoxes(data);
    const mdats = top.filter(item => item.type === 'mdat');
    this.segmentSamples = 0;
    // HLS segments start on a keyframe; CMAF chunks inside one may not.
    this.segmentStarted = new Set();
    for (const moof of top.filter(item => item.type === 'moof')) {
      const trafs = children(data, moof).filter(item => item.type === 'traf');
      let previousEnd = moof.start;
      for (const traf of trafs) {
        previousEnd = this.#appendTraf({input, data, moof, traf, previousEnd, mdats, out, fileOffset});
      }
    }
    if (!out.length && !top.some(item => item.type === 'moof')) {
      throw new UnsupportedError('A downloaded segment contained no video data.');
    }
    return out;
  }

  #appendTraf({input, data, moof, traf, previousEnd, mdats, out, fileOffset}) {
    const kids = children(data, traf);
    if (kids.some(item => ['senc', 'saiz', 'saio'].includes(item.type))) throw new ProtectedError();
    const tfhd = required(kids.find(item => item.type === 'tfhd'), 'a fragment header');
    const flags = u32(data, tfhd.body) & 0xffffff;
    const track = input.byId.get(u32(data, tfhd.body + 4));
    if (!track) throw new UnsupportedError('A segment referenced an unknown track.');
    let at = tfhd.body + 8;
    let base;
    if (flags & 0x1) {
      // An absolute file offset; translate it into this buffer.
      base = u64(data, at) - fileOffset;
      at += 8;
      if (base < 0 || base >= data.length) throw new UnsupportedError('This stream uses offsets that point outside the segment.');
    } else if (flags & 0x20000) base = moof.start;
    else base = previousEnd; // First traf: the moof itself; later ones follow the previous traf's data.
    const defaults = {...track.trex};
    if (flags & 0x2) { defaults.sampleDescription = u32(data, at); at += 4; }
    if (flags & 0x8) { defaults.duration = u32(data, at); at += 4; }
    if (flags & 0x10) { defaults.size = u32(data, at); at += 4; }
    if (flags & 0x20) defaults.flags = u32(data, at);

    const tfdt = kids.find(item => item.type === 'tfdt');
    // Ticks of audio this fragment repeats from the previous one; those samples are dropped.
    let skip = 0;
    if (tfdt) {
      const time = data[tfdt.body] === 1 ? u64(data, tfdt.body + 4) : u32(data, tfdt.body + 4);
      skip = this.#alignTimeline(track, time);
    }

    let dataAt = base;
    for (const trun of kids.filter(item => item.type === 'trun')) {
      const runFlags = u32(data, trun.body) & 0xffffff;
      const count = u32(data, trun.body + 4);
      this.segmentSamples += count;
      if (this.segmentSamples > MAX_SEGMENT_SAMPLES) throw new UnsupportedError('A segment has a damaged sample table.');
      let p = trun.body + 8;
      if (runFlags & 0x1) { dataAt = base + dv(data).getInt32(p); p += 4; }
      let firstFlags = null;
      if (runFlags & 0x4) { firstFlags = u32(data, p); p += 4; }
      const perSample = ((runFlags >> 8) & 1) + ((runFlags >> 9) & 1) + ((runFlags >> 10) & 1) + ((runFlags >> 11) & 1);
      if (p + count * perSample * 4 > trun.end) throw new UnsupportedError('A segment has a damaged sample table.');
      let start = dataAt, kept = 0;
      for (let i = 0; i < count; i++) {
        const duration = runFlags & 0x100 ? u32(data, (p += 4) - 4) : defaults.duration;
        const size = runFlags & 0x200 ? u32(data, (p += 4) - 4) : defaults.size;
        let sampleFlags = runFlags & 0x400 ? u32(data, (p += 4) - 4) : defaults.flags;
        if (i === 0 && firstFlags !== null) sampleFlags = firstFlags;
        // Composition offsets are signed in practice even in version 0 boxes,
        // which is how ffmpeg and browsers read them too.
        let offset = 0;
        if (runFlags & 0x800) { offset = dv(data).getInt32(p); p += 4; }
        if (dataAt + size > data.length) throw new UnsupportedError('A segment is damaged or incomplete.');
        dataAt += size;
        if (skip > 0) {
          skip -= duration;
          start = dataAt;
          continue;
        }
        this.#addSample(track, duration, size, sampleFlags, offset);
        if (!this.segmentStarted.has(track)) {
          this.segmentStarted.add(track);
          track.segmentStarts.push(track.samples);
        }
        kept++;
      }
      if (!kept) continue;
      if (!mdats.some(mdat => start >= mdat.body && dataAt <= mdat.end)) {
        throw new UnsupportedError('A segment’s sample data is outside its media box.');
      }
      track.chunkOffsets.push(this.position);
      track.chunkSamples.push(kept);
      track.chunkDescriptions.push(defaults.sampleDescription || 1);
      out.push(data.subarray(start, dataAt));
      this.position += dataAt - start;
    }
    return dataAt;
  }

  /** Line a fragment up with what came before. Returns ticks of overlap to drop. */
  #alignTimeline(track, time) {
    if (track.nextDecodeTime === null) {
      track.firstDecodeTime = time;
      track.nextDecodeTime = time;
      return 0;
    }
    const gap = time - track.nextDecodeTime;
    if (!gap || !track.samples) return 0;
    if (gap < 0 && track.handler === 'soun') {
      const frame = track.durations.last;
      // A jump back of more than a second is a timestamp reset, not repeated
      // audio: keep everything rather than drop the rest of the track.
      if (-gap > track.timescale || frame <= 0) {
        track.nextDecodeTime = time;
        return 0;
      }
      // Repeated audio would push everything after it out of sync: drop whole
      // repeated frames, and absorb sub-frame jitter (at most half a frame)
      // into the previous sample instead of losing a real frame to it.
      const drop = Math.round(-gap / frame);
      const residual = gap + drop * frame;
      track.durations.last = frame + residual;
      track.outputTime += residual;
      track.nextDecodeTime = time + drop * frame;
      return drop * frame;
    }
    // Otherwise absorb the jump into the previous sample's duration.
    const adjusted = track.durations.last + gap;
    if (adjusted > 0 && adjusted <= 0xffffffff) {
      track.durations.last = adjusted;
      track.nextDecodeTime = time;
      track.outputTime += gap;
    }
    return 0;
  }

  #addSample(track, duration, size, flags, offset) {
    track.samples++;
    track.sizes.push(size);
    track.durations.push(duration);
    track.offsets.push(offset);
    if (offset) track.hasOffsets = true;
    if (offset < track.minOffset) track.minOffset = offset;
    // sample_is_non_sync_sample is bit 16 of the sample flags.
    if (flags & 0x10000) track.nonSync = true;
    else track.syncs.push(track.samples);
    // sample_depends_on == 2 (bits 24-25): an intra frame, the fallback for
    // streams that mark every sample non-sync.
    if (((flags >>> 24) & 3) === 2) track.independent.push(track.samples);
    if (track.nextDecodeTime === null) track.nextDecodeTime = 0;
    track.nextDecodeTime += duration;
    // Latest composition end, so the edit list covers every frame shown.
    track.presentationEnd = Math.max(track.presentationEnd, track.outputTime + offset + duration);
    track.outputTime += duration;
  }

  /**
   * Finish the file. Returns the 8-byte mdat size to write at `sizePatch.position`
   * and the moov box to append at the end.
   */
  finish() {
    if (!this.tracks.some(track => track.samples)) throw new UnsupportedError('No video data was downloaded.');
    const mdatSize = this.position - this.mdatStart;
    const sizePatch = {position: this.mdatStart + 8, data: new Writer(8).u64(mdatSize).done()};
    const now = Math.floor(Date.now() / 1000) + MAC_EPOCH_OFFSET;
    const tracks = this.tracks.filter(track => track.samples);
    // Where each track starts, from its first decode time plus any leading
    // empty edits. A track starting later than the others gets an empty edit
    // so audio and video stay in sync; an offset they all share is dropped.
    // media_time is on the track's own media timeline, which starts at the
    // first tfdt; if it points at or past that, it already accounts for it.
    const start = track => {
      const first = track.firstDecodeTime || 0;
      const media = track.edits.find(edit => edit.mediaTime >= 0)?.mediaTime ?? 0;
      return (media >= first ? 0 : first / track.timescale) + leadingEmpty(track.edits) / track.sourceMovieScale;
    };
    const earliest = Math.min(...tracks.map(start));
    for (const track of tracks) track.leadingGap = start(track) - earliest;
    const traks = tracks.map(track => this.#trak(track, now));
    const duration = Math.max(...tracks.map(track => track.presentationDuration));
    const mvhd = this.#mvhd(now, duration, this.tracks.length + 1);
    const udta = this.#metadata();
    return {sizePatch, moov: box('moov', mvhd, ...traks, ...(udta ? [udta] : []))};
  }

  #mvhd(now, duration, nextTrackId) {
    const v1 = duration > 0xffffffff;
    const w = new Writer(108);
    if (v1) w.u64(now).u64(now).u32(this.movieScale).u64(duration);
    else w.u32(now).u32(now).u32(this.movieScale).u32(duration);
    w.u32(0x00010000).u16(0x0100).u16(0).u32(0).u32(0);
    for (const value of [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]) w.u32(value);
    for (let i = 0; i < 6; i++) w.u32(0);
    w.u32(nextTrackId);
    return fullBox('mvhd', v1 ? 1 : 0, 0, w.done());
  }

  #trak(track, now) {
    const mediaDuration = sum(track.durations);
    const toMovie = value => Math.round(value * this.movieScale / track.timescale);
    // Negative composition offsets are shifted up so ctts can be version 0,
    // which every reader understands; the edit list absorbs the shift.
    const shift = track.minOffset < 0 ? -track.minOffset : 0;
    // Rebuild the edit list as: optional empty edit (late start), then one
    // edit covering all the media. Fragmented inits leave its duration at zero.
    const mediaEdit = track.edits.find(edit => edit.mediaTime >= 0);
    // Decode times are rebased to start at zero here, so a media_time that
    // was relative to a later first tfdt is rebased too.
    const first = track.firstDecodeTime || 0;
    const sourceTime = mediaEdit?.mediaTime ?? 0;
    const mediaTime = (sourceTime >= first ? sourceTime - first : sourceTime) + shift;
    const end = Math.max(mediaDuration, track.presentationEnd + shift);
    const gap = Math.round(track.leadingGap * this.movieScale);
    const edits = [];
    if (gap > 0) edits.push({duration: gap, mediaTime: -1, rate: 1});
    if (gap > 0 || mediaTime !== 0) {
      edits.push({duration: toMovie(Math.max(0, end - mediaTime)), mediaTime, rate: mediaEdit?.rate || 1});
    }
    track.shift = shift;
    const presentation = edits.length ? edits.reduce((total, edit) => total + edit.duration, 0) : toMovie(mediaDuration);
    track.presentationDuration = presentation;

    const tkhdV1 = presentation > 0xffffffff;
    const tkhd = new Writer(92);
    if (tkhdV1) tkhd.u64(now).u64(now).u32(track.id).u32(0).u64(presentation);
    else tkhd.u32(now).u32(now).u32(track.id).u32(0).u32(presentation);
    tkhd.raw(track.tkhdTail);

    const mdhdV1 = mediaDuration > 0xffffffff;
    const mdhd = new Writer(32);
    if (mdhdV1) mdhd.u64(now).u64(now).u32(track.timescale).u64(mediaDuration);
    else mdhd.u32(now).u32(now).u32(track.timescale).u32(mediaDuration);
    mdhd.raw(track.language);

    const parts = [fullBox('tkhd', tkhdV1 ? 1 : 0, 7, tkhd.done())];
    if (edits.length) parts.push(box('edts', this.#elst(edits)));
    parts.push(box('mdia',
      fullBox('mdhd', mdhdV1 ? 1 : 0, 0, mdhd.done()),
      track.hdlr,
      box('minf', ...track.minfHeaders, this.#stbl(track))));
    return box('trak', ...parts);
  }

  #elst(edits) {
    const v1 = edits.some(edit => edit.duration > 0xffffffff || Math.abs(edit.mediaTime) > 0x7fffffff);
    const w = new Writer().u32(edits.length);
    for (const edit of edits) {
      if (v1) w.u64(edit.duration).u64(BigInt.asUintN(64, BigInt(edit.mediaTime)));
      else w.u32(edit.duration).i32(edit.mediaTime);
      w.u16(edit.rate ?? 1).u16(0);
    }
    return fullBox('elst', v1 ? 1 : 0, 0, w.done());
  }

  #stbl(track) {
    const stts = new Writer();
    const durationRuns = runs(track.durations);
    stts.u32(durationRuns.length);
    for (const [count, value] of durationRuns) stts.u32(count).u32(value);

    const parts = [track.stsd, fullBox('stts', 0, 0, stts.done())];

    if (track.hasOffsets) {
      const offsetRuns = runs(track.offsets);
      const ctts = new Writer().u32(offsetRuns.length);
      for (const [count, value] of offsetRuns) ctts.u32(count).u32(value + track.shift);
      parts.push(fullBox('ctts', 0, 0, ctts.done()));
    }

    // Audio samples are all sync samples, whatever the fragments claim. For
    // video, an empty table would mean "nowhere to start" and no table would
    // mean "start anywhere": if nothing was flagged sync, fall back to intra
    // frames, then to the first sample of each HLS segment (which starts on
    // a keyframe).
    if (track.nonSync && track.handler !== 'soun') {
      const syncs = [track.syncs, track.independent, track.segmentStarts].find(list => list.length);
      const stss = new Writer().u32(syncs.length);
      syncs.forEach(value => stss.u32(value));
      parts.push(fullBox('stss', 0, 0, stss.done()));
    }

    const stsc = new Writer();
    const entries = [];
    track.chunkSamples.forEach((count, index) => {
      const description = track.chunkDescriptions.items[index];
      const tail = entries.at(-1);
      if (!tail || tail.count !== count || tail.description !== description) {
        entries.push({first: index + 1, count, description});
      }
    });
    stsc.u32(entries.length);
    for (const entry of entries) stsc.u32(entry.first).u32(entry.count).u32(entry.description);
    parts.push(fullBox('stsc', 0, 0, stsc.done()));

    const stsz = new Writer();
    const first = track.sizes.items[0];
    let uniform = true;
    track.sizes.forEach(value => { if (value !== first) uniform = false; });
    if (uniform) stsz.u32(first).u32(track.samples);
    else {
      stsz.u32(0).u32(track.samples);
      track.sizes.forEach(value => stsz.u32(value));
    }
    parts.push(fullBox('stsz', 0, 0, stsz.done()));

    const large = track.chunkOffsets.last > 0xffffffff;
    const offsets = new Writer().u32(track.chunkOffsets.length);
    track.chunkOffsets.forEach(value => (large ? offsets.u64(value) : offsets.u32(value)));
    parts.push(fullBox(large ? 'co64' : 'stco', 0, 0, offsets.done()));

    return box('stbl', ...parts);
  }

  // iTunes-style tags so players and file browsers show the real title.
  #metadata() {
    const tags = [['©nam', this.metadata.title], ['©ART', this.metadata.artist],
      ['©cmt', this.metadata.comment], ['©too', this.metadata.tool]]
      .filter(([, value]) => value);
    if (!tags.length) return null;
    const items = tags.map(([name, value]) => {
      const key = new Uint8Array([0xa9, ...textEncoder.encode(name.slice(1))]);
      const data = box('data', new Writer().u32(1).u32(0).str(String(value).slice(0, 1000)).done());
      return box(key, data);
    });
    const hdlr = fullBox('hdlr', 0, 0, new Writer().u32(0).str('mdir').str('appl').u32(0).u32(0).u8(0).done());
    return box('udta', fullBox('meta', 0, 0, concatBytes([hdlr, box('ilst', ...items)])));
  }
}

/** Total duration of the empty edits a track's edit list starts with. */
function leadingEmpty(edits) {
  let total = 0;
  for (const edit of edits) {
    if (edit.mediaTime >= 0) break;
    total += edit.duration;
  }
  return total;
}

function sum(list) {
  let total = 0;
  list.forEach(value => { total += value; });
  return total;
}

export function concatBytes(parts) {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
