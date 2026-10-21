// Package extension/ into dist/vimeo-grab-<version>.zip, ready for the
// Chrome Web Store or for "Load unpacked" after extracting.
// No dependencies: a small ZIP writer on top of Node's zlib. Output is
// reproducible (sorted entries, fixed timestamps).
import {readFileSync, readdirSync, statSync, mkdirSync, writeFileSync} from 'node:fs';
import {join, relative, sep} from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'extension');
const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
const out = join(root, 'dist', `vimeo-grab-${manifest.version}.zip`);

function files(dir) {
  return readdirSync(dir).filter(name => !name.startsWith('.')).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const CRC_TABLE = Array.from({length: 256}, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// 1980-01-01 00:00, the earliest DOS timestamp: identical bytes on every build.
const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1;

const locals = [], centrals = [];
let offset = 0;
for (const path of files(source).sort()) {
  const name = Buffer.from(relative(source, path).split(sep).join('/'), 'utf8');
  const data = readFileSync(path);
  const packed = deflateRawSync(data, {level: 9});
  const store = packed.length >= data.length;
  const body = store ? data : packed;
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(store ? 0 : 8, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  locals.push(local, name, body);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(store ? 0 : 8, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);
  offset += local.length + name.length + body.length;
}
const directory = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(centrals.length / 2, 8);
end.writeUInt16LE(centrals.length / 2, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(join(root, 'dist'), {recursive: true});
writeFileSync(out, Buffer.concat([...locals, directory, end]));
console.log(`Built ${relative(root, out)} (${centrals.length / 2} files, ${(statSync(out).size / 1024).toFixed(0)} KB)`);
