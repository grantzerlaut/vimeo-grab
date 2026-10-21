// Where an assembled video is written before Chrome saves it to Downloads.
//
// OPFS (the extension's private on-disk storage) keeps memory use flat no
// matter how long the video is. If it is unavailable, fall back to memory
// with a size cap so a huge video fails cleanly instead of crashing the tab.

const TEMP_DIR = 'vimeo-grab-temp';
export const MEMORY_LIMIT = 1536 * 1024 * 1024;

async function tempDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(TEMP_DIR, {create: true});
}

export class OpfsSink {
  static async create(name) {
    const dir = await tempDir();
    const handle = await dir.getFileHandle(name, {create: true});
    const writable = await handle.createWritable({keepExistingData: false});
    return new OpfsSink(dir, name, handle, writable);
  }

  constructor(dir, name, handle, writable) {
    Object.assign(this, {dir, name, handle, writable, position: 0});
  }

  async write(data) {
    await this.writable.write({type: 'write', position: this.position, data});
    this.position += data.length;
  }

  async writeAt(position, data) {
    await this.writable.write({type: 'write', position, data});
  }

  /** Finish writing and return a disk-backed File. */
  async close() {
    await this.writable.close();
    return this.handle.getFile();
  }

  async discard() {
    await this.writable.abort().catch(() => {});
    await this.dir.removeEntry(this.name).catch(() => {});
  }
}

export class MemorySink {
  constructor(limit = MEMORY_LIMIT) {
    this.parts = [];
    this.position = 0;
    this.patches = [];
    this.limit = limit;
  }

  async write(data) {
    this.position += data.length;
    if (this.position > this.limit) {
      throw new Error('This video is too large to assemble in memory. Choose a lower quality.');
    }
    this.parts.push(data.slice());
  }

  async writeAt(position, data) { this.patches.push({position, data: data.slice()}); }

  async close() {
    // Patches only ever touch the 16-byte header written first.
    for (const {position, data} of this.patches) {
      let offset = 0;
      for (const part of this.parts) {
        const from = Math.max(position, offset), to = Math.min(position + data.length, offset + part.length);
        if (from < to) part.set(data.subarray(from - position, to - position), from - offset);
        offset += part.length;
      }
    }
    const blob = new Blob(this.parts, {type: 'video/mp4'});
    this.parts = [];
    return blob;
  }

  async discard() { this.parts = []; }
}

/** Delete a finished temp file once Chrome has copied it to Downloads. */
export async function removeTemp(name) {
  try { await (await tempDir()).removeEntry(name); } catch { /* Already gone. */ }
}

/** Remove temp files left behind by a crash or browser restart. */
export async function clearTemp(keep = new Set()) {
  try {
    const dir = await tempDir();
    for await (const name of dir.keys()) if (!keep.has(name)) await dir.removeEntry(name).catch(() => {});
  } catch { /* OPFS unavailable: nothing to clean. */ }
}

/** Free bytes in the extension's storage quota, or Infinity if unknown. */
export async function freeSpace() {
  try {
    const {quota = 0, usage = 0} = await navigator.storage.estimate();
    return quota ? quota - usage : Infinity;
  } catch { return Infinity; }
}
