'use strict';
// Read single files out of a big .zip on the web without downloading all of it (HTTP range requests).
// Used to fetch just the parts of RIFE that xan needs from a ~430 MB release.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

async function range(url, start, end, signal) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, redirect: 'follow', signal });
  if (res.status !== 206 && !(res.status === 200 && start === 0)) throw new Error(`The download server did not accept a partial request (status ${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

async function totalSize(url, signal) {
  // ask for the last byte: the reply says how big the whole file is
  const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow', signal });
  const m = /\/(\d+)$/.exec(res.headers.get('content-range') || '');
  await res.arrayBuffer();
  if (!m) throw new Error('Could not read the size of the download.');
  return Number(m[1]);
}

async function listZip(url, signal) {
  const size = await totalSize(url, signal);
  const tailLen = Math.min(size, 1 << 20);
  const tail = await range(url, size - tailLen, size - 1, signal);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('The download is not a zip file.');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOff = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff) throw new Error('This zip is too large for xan to read.');
  const cd = cdOff >= size - tailLen ? tail.subarray(cdOff - (size - tailLen), cdOff - (size - tailLen) + cdSize) : await range(url, cdOff, cdOff + cdSize - 1, signal);
  const entries = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const method = cd.readUInt16LE(p + 10);
    const csize = cd.readUInt32LE(p + 20);
    const usize = cd.readUInt32LE(p + 24);
    const nl = cd.readUInt16LE(p + 28), el = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
    const off = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nl);
    entries.push({ name, method, csize, usize, off });
    p += 46 + nl + el + cl;
  }
  return entries;
}

async function readEntry(url, e, signal) {
  const head = await range(url, e.off, e.off + 29 + 1024, signal);
  if (head.readUInt32LE(0) !== 0x04034b50) throw new Error('The download is damaged (bad zip entry).');
  const start = e.off + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  if (e.csize === 0) return Buffer.alloc(0);
  const data = await range(url, start, start + e.csize - 1, signal);
  if (e.method === 0) return data;
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`Unsupported zip compression (${e.method}).`);
}

// entries: the chosen entries; dest: folder; strip: leading folder to drop; onProgress(doneBytes,totalBytes)
async function extract(url, entries, dest, strip, onProgress, signal) {
  const total = entries.reduce((a, e) => a + e.csize, 0);
  let done = 0;
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;
    const rel = strip && e.name.startsWith(strip) ? e.name.slice(strip.length) : e.name;
    const out = path.join(dest, rel);
    if (!path.resolve(out).startsWith(path.resolve(dest) + path.sep)) throw new Error('The download contains an unsafe path.');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, await readEntry(url, e, signal));
    done += e.csize;
    if (onProgress) onProgress(done, total);
  }
}

module.exports = { listZip, extract, readEntry };
