'use strict';

/**
 * Writing a DVD-Video disc image, byte for byte.
 *
 * A DVD-Video disc is not just a UDF filesystem with a VIDEO_TS folder on it.
 * The IFO files that dvdauthor writes carry sector addresses — where the menu
 * video starts relative to its IFO, where each title set starts relative to
 * VIDEO_TS.IFO — and a set-top player navigates by those addresses rather than by
 * the filesystem. So the files have to sit on the disc exactly where the IFOs say
 * they do, padding and all.
 *
 * Neither system imager does that. IMAPI on Windows lays the folder out
 * alphabetically, which puts every BUP in front of its IFO and closes the gaps
 * dvdauthor left: measured on a two-title disc, VIDEO_TS.IFO said the title set
 * began 32 sectors after it, and IMAPI's image had it 9 sectors after. hdiutil's
 * makehybrid has no DVD-Video mode either. `mkisofs -dvd-video` gets it right,
 * and this does what it does: it reads the IFOs, and places every file where
 * they say.
 *
 * The image is UDF 1.02 — the version the DVD-Video specification requires —
 * with an ISO 9660 bridge over the same file data, which is the structure every
 * commercial DVD has.
 *
 * It is also the fast way to make one. The image is one sequential write of the
 * files plus a few dozen sectors of tables, with nothing to install and nothing
 * that differs between the two platforms.
 */

const fs = require('fs');
const path = require('path');
const { AbortError } = require('./encode');

const SECTOR = 2048;

// Where everything that is not file data goes. The numbers are the ones
// mkisofs uses, which every reader is known to be comfortable with.
const ISO_PVD = 16;
const ISO_TERMINATOR = 17;
const VRS_BEA = 18;
const VRS_NSR = 19;
const VRS_TEA = 20;
const ISO_L_PATH = 21;
const ISO_M_PATH = 22;
const ISO_FIRST_DIR = 23;
const UDF_MAIN_VDS = 32;
const UDF_RESERVE_VDS = 48;
const UDF_VDS_LENGTH = 16;
const UDF_LVID = 64;
const UDF_AVDP = 256;
const PARTITION_START = 257;

// The longest single extent UDF allows that is a whole number of blocks. A
// VOB can be a full gigabyte, which is one block more than that.
const MAX_EXTENT = 0x3ffff800;

const UDF_REVISION = 0x0102;
const IMPLEMENTATION = '*Burnhouse';

// ------------------------------------------------------------ DVD layout ---

function sectorsOf(bytes) {
  return Math.ceil(bytes / SECTOR);
}

/**
 * Where each file in VIDEO_TS goes, in sectors relative to VIDEO_TS.IFO.
 *
 * Read from the IFOs themselves:
 *
 *   VIDEO_TS.IFO   at 0
 *   VIDEO_TS.VOB   at the menu start the VMG table gives (0xC0)
 *   VIDEO_TS.BUP   ending on the VMG's last sector (0x0C)
 *   VTS_nn_0.IFO   at the title set start in TT_SRPT
 *   VTS_nn_0.VOB   at the menu start its own table gives (0xC0)
 *   VTS_nn_1..9    back to back from the title start (0xC4)
 *   VTS_nn_0.BUP   ending on the title set's last sector (0x0C)
 *
 * Returns null when the IFOs cannot be read or describe something impossible.
 * The caller then falls back to the plain DVD order, which is what every other
 * imager would have produced anyway.
 */
function planDvdLayout(videoTsDir, sizes) {
  const has = (name) => sizes.has(name);
  const sizeOf = (name) => sectorsOf(sizes.get(name));
  if (!has('VIDEO_TS.IFO')) return null;

  const vmgIfo = path.join(videoTsDir, 'VIDEO_TS.IFO');
  let header;
  try {
    header = fs.readFileSync(vmgIfo);
  } catch {
    return null;
  }
  if (header.length < 0x100 || header.toString('latin1', 0, 12) !== 'DVDVIDEO-VMG') return null;

  const placed = new Map();
  const vmgLast = header.readUInt32BE(0x0c);
  const vmgmVobs = header.readUInt32BE(0xc0);
  const ttSrptSector = header.readUInt32BE(0xc4);
  const titleSets = header.readUInt16BE(0x3e);

  placed.set('VIDEO_TS.IFO', 0);
  if (has('VIDEO_TS.VOB')) {
    if (!vmgmVobs) return null;
    placed.set('VIDEO_TS.VOB', vmgmVobs);
  }
  if (has('VIDEO_TS.BUP')) placed.set('VIDEO_TS.BUP', vmgLast + 1 - sizeOf('VIDEO_TS.BUP'));

  // Where each title set starts, from the title table.
  const starts = new Map();
  const ttOffset = ttSrptSector * SECTOR;
  if (ttSrptSector && header.length >= ttOffset + 8) {
    const count = header.readUInt16BE(ttOffset);
    for (let i = 0; i < count; i += 1) {
      const at = ttOffset + 8 + i * 12;
      if (header.length < at + 12) return null;
      const vts = header[at + 6];
      const sector = header.readUInt32BE(at + 8);
      if (starts.has(vts) && starts.get(vts) !== sector) return null;
      starts.set(vts, sector);
    }
  }

  let nextVts = vmgLast + 1;
  for (let n = 1; n <= titleSets; n += 1) {
    const prefix = `VTS_${String(n).padStart(2, '0')}`;
    const ifoName = `${prefix}_0.IFO`;
    if (!has(ifoName)) return null;
    const ifo = path.join(videoTsDir, ifoName);

    const base = starts.has(n) ? starts.get(n) : nextVts;
    let vtsLast;
    let menuVobs;
    let titleVobs;
    try {
      const fd = fs.openSync(ifo, 'r');
      const buf = Buffer.alloc(0xc8);
      try {
        fs.readSync(fd, buf, 0, buf.length, 0);
      } finally {
        fs.closeSync(fd);
      }
      if (buf.toString('latin1', 0, 12) !== 'DVDVIDEO-VTS') return null;
      vtsLast = buf.readUInt32BE(0x0c);
      menuVobs = buf.readUInt32BE(0xc0);
      titleVobs = buf.readUInt32BE(0xc4);
    } catch {
      return null;
    }

    placed.set(ifoName, base);
    if (has(`${prefix}_0.VOB`)) {
      if (!menuVobs) return null;
      placed.set(`${prefix}_0.VOB`, base + menuVobs);
    }
    let at = base + titleVobs;
    for (let part = 1; part <= 9; part += 1) {
      const name = `${prefix}_${part}.VOB`;
      if (!has(name)) break;
      placed.set(name, at);
      at += sizeOf(name);
    }
    if (has(`${prefix}_0.BUP`)) placed.set(`${prefix}_0.BUP`, base + vtsLast + 1 - sizeOf(`${prefix}_0.BUP`));
    nextVts = base + vtsLast + 1;
  }

  // Nothing may overlap, and nothing may start before the disc does. A table
  // that says otherwise is not one to burn by.
  const order = [...placed.entries()].sort((a, b) => a[1] - b[1]);
  let end = 0;
  for (const [name, start] of order) {
    if (start < end) return null;
    end = start + sizeOf(name);
  }

  return order.map(([name, start]) => ({ name, offset: start }));
}

/** The order a DVD-Video folder is conventionally written in, with no padding. */
function plainDvdOrder(names) {
  const rank = (name) => {
    const vmg = /^VIDEO_TS\.(IFO|VOB|BUP)$/i.exec(name);
    if (vmg) return [0, 0, { IFO: 0, VOB: 1, BUP: 3 }[vmg[1].toUpperCase()], 0];
    const vts = /^VTS_(\d\d)_(\d)\.(IFO|VOB|BUP)$/i.exec(name);
    if (vts) {
      const kind = vts[3].toUpperCase();
      const part = Number(vts[2]);
      const slot = kind === 'IFO' ? 0 : kind === 'BUP' ? 3 : part === 0 ? 1 : 2;
      return [1, Number(vts[1]), slot, part];
    }
    return [2, 0, 0, 0];
  };
  return [...names].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

// --------------------------------------------------------- encoding bits ---

function crc16(buf) {
  // CRC-ITU-T as ECMA-167 specifies it: polynomial 0x1021, starting from zero.
  let crc = 0;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i] << 8;
    for (let b = 0; b < 8; b += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** Fill in a descriptor tag, including its checksum and CRC. */
function tag(buf, id, location, length = buf.length) {
  buf.writeUInt16LE(id, 0);
  buf.writeUInt16LE(2, 2); // descriptor version 2: UDF 1.02 / NSR02
  buf.writeUInt8(0, 4);
  buf.writeUInt8(0, 5);
  buf.writeUInt16LE(0, 6); // serial number, the same on every descriptor
  const crcLength = length - 16;
  buf.writeUInt16LE(crc16(buf.subarray(16, length)), 8);
  buf.writeUInt16LE(crcLength, 10);
  buf.writeUInt32LE(location, 12);
  let sum = 0;
  for (let i = 0; i < 16; i += 1) if (i !== 4) sum += buf[i];
  buf.writeUInt8(sum & 0xff, 4);
}

function charspec(buf, at) {
  buf.writeUInt8(0, at); // CS0
  buf.write('OSTA Compressed Unicode', at + 1, 'latin1');
}

/** A fixed-size OSTA CS0 string: compression byte, characters, length last. */
function dstring(buf, at, size, text) {
  const chars = Buffer.from(String(text || ''), 'latin1').subarray(0, size - 2);
  if (!chars.length) return;
  buf.writeUInt8(8, at);
  chars.copy(buf, at + 1);
  buf.writeUInt8(chars.length + 1, at + size - 1);
}

function regid(buf, at, identifier, suffix = []) {
  buf.writeUInt8(0, at);
  buf.write(identifier, at + 1, 23, 'latin1');
  Buffer.from(suffix).copy(buf, at + 24, 0, 8);
}

const udfSuffix = [UDF_REVISION & 0xff, UDF_REVISION >> 8, 0, 0];

function timestamp(buf, at, date) {
  buf.writeUInt16LE(0x1000, at); // local time, offset zero: UTC
  buf.writeInt16LE(date.getUTCFullYear(), at + 2);
  buf.writeUInt8(date.getUTCMonth() + 1, at + 4);
  buf.writeUInt8(date.getUTCDate(), at + 5);
  buf.writeUInt8(date.getUTCHours(), at + 6);
  buf.writeUInt8(date.getUTCMinutes(), at + 7);
  buf.writeUInt8(date.getUTCSeconds(), at + 8);
  buf.writeUInt8(0, at + 9);
  buf.writeUInt8(0, at + 10);
  buf.writeUInt8(0, at + 11);
}

function longAd(buf, at, length, block, uniqueId = 0) {
  buf.writeUInt32LE(length, at);
  buf.writeUInt32LE(block, at + 4);
  buf.writeUInt16LE(0, at + 8); // partition reference
  buf.writeUInt16LE(0, at + 10); // implementation use: flags
  buf.writeUInt32LE(uniqueId >>> 0, at + 12); // and the UDF unique id
}

function both16(buf, at, value) {
  buf.writeUInt16LE(value, at);
  buf.writeUInt16BE(value, at + 2);
}

function both32(buf, at, value) {
  buf.writeUInt32LE(value, at);
  buf.writeUInt32BE(value, at + 4);
}

function isoDate7(buf, at, date) {
  buf.writeUInt8(date.getUTCFullYear() - 1900, at);
  buf.writeUInt8(date.getUTCMonth() + 1, at + 1);
  buf.writeUInt8(date.getUTCDate(), at + 2);
  buf.writeUInt8(date.getUTCHours(), at + 3);
  buf.writeUInt8(date.getUTCMinutes(), at + 4);
  buf.writeUInt8(date.getUTCSeconds(), at + 5);
  buf.writeInt8(0, at + 6);
}

function isoDate17(buf, at, date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const text = date
    ? `${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
      `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}00`
    : '0000000000000000';
  buf.write(text, at, 16, 'latin1');
  buf.writeInt8(0, at + 16);
}

function padSpaces(buf, at, size, text = '') {
  buf.fill(0x20, at, at + size);
  buf.write(String(text).slice(0, size), at, 'latin1');
}

// ----------------------------------------------------------- the image ---

/**
 * Lay the image out: every structure's sector, and every file's.
 *
 * Exported separately from writing it so the plan can be tested on its own, and
 * so the size of the finished image is known before a byte is written.
 */
function planImage({ sourceDir, volumeLabel }) {
  const label = String(volumeLabel || 'DVD_VIDEO').toUpperCase();
  const dirs = [];
  for (const name of ['VIDEO_TS', 'AUDIO_TS']) {
    const full = path.join(sourceDir, name);
    let isDir = false;
    try {
      isDir = fs.statSync(full).isDirectory();
    } catch {
      /* absent */
    }
    if (name === 'VIDEO_TS' && !isDir) throw new Error(`There is no VIDEO_TS folder in ${sourceDir}.`);
    // AUDIO_TS is always on the disc, empty. Some old players look for it.
    const files = [];
    if (isDir) {
      for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const upper = entry.name.toUpperCase();
        // Only names a DVD player could ever ask for: 8.3, upper case. Finder
        // and Explorer droppings (.DS_Store, Thumbs.db) stay off the disc.
        if (!/^[A-Z0-9_]{1,8}\.[A-Z0-9_]{1,3}$/.test(upper)) continue;
        files.push({ name: upper, path: path.join(full, entry.name), size: fs.statSync(path.join(full, entry.name)).size });
      }
    }
    dirs.push({ name, files });
  }

  const videoTs = dirs[0];
  const sizes = new Map(videoTs.files.map((f) => [f.name, f.size]));
  const layout = planDvdLayout(path.join(sourceDir, 'VIDEO_TS'), sizes);
  const dvdCompliant = Boolean(layout);
  const byName = new Map(videoTs.files.map((f) => [f.name, f]));
  const ordered = layout
    ? layout.map((entry) => ({ ...byName.get(entry.name), relative: entry.offset }))
    : plainDvdOrder(videoTs.files.map((f) => f.name)).map((name) => ({ ...byName.get(name), relative: null }));
  // Anything in VIDEO_TS the IFOs did not mention goes after the disc proper.
  const mentioned = new Set(ordered.map((f) => f.name));
  const extra = videoTs.files.filter((f) => !mentioned.has(f.name));

  // Partition blocks, relative to PARTITION_START.
  //   0 File Set Descriptor, 1 its terminator,
  //   then a File Entry and a directory block for each folder (root first),
  //   then a File Entry for each file, then the data.
  let block = 2;
  const root = { feBlock: block++, dataBlock: block++ };
  for (const dir of dirs) {
    dir.feBlock = block++;
    dir.dataBlock = block++;
  }
  const allFiles = [...ordered, ...extra];
  for (const file of allFiles) file.feBlock = block++;

  // File data. The DVD files keep exactly the spacing the IFOs describe.
  const dataStart = block;
  let cursor = dataStart;
  if (layout) {
    for (const file of ordered) {
      file.block = dataStart + file.relative;
      cursor = Math.max(cursor, file.block + sectorsOf(file.size));
    }
  } else {
    for (const file of ordered) {
      file.block = cursor;
      cursor += sectorsOf(file.size);
    }
  }
  for (const file of extra) {
    file.block = cursor;
    cursor += sectorsOf(file.size);
  }

  const partitionLength = cursor;
  // The closing anchor is the very last sector, outside the partition.
  const totalSectors = PARTITION_START + partitionLength + 1;

  return {
    label,
    root,
    dirs,
    files: allFiles,
    dvdCompliant,
    partitionLength,
    totalSectors,
    totalBytes: totalSectors * SECTOR,
  };
}

/** Every sector that is not file data, as a map of sector number to bytes. */
function buildStructures(plan, now = new Date()) {
  const sectors = new Map();
  const blank = () => Buffer.alloc(SECTOR);
  const put = (sector, buf) => sectors.set(sector, buf);
  const abs = (block) => PARTITION_START + block;

  const isoLabel = plan.label.replace(/[^A-Z0-9_]/g, '_').slice(0, 32);
  const udfLabel = plan.label.slice(0, 30);

  // ---------------------------------------------------- ISO 9660 bridge ---
  // Directory numbers in path table order: root, then its children by name.
  const isoDirs = [...plan.dirs].sort((a, b) => (a.name < b.name ? -1 : 1));
  const isoDirSector = new Map();
  let nextIsoSector = ISO_FIRST_DIR;
  isoDirSector.set('/', nextIsoSector++);
  for (const dir of isoDirs) isoDirSector.set(dir.name, nextIsoSector++);
  if (nextIsoSector > UDF_MAIN_VDS) throw new Error('Too many folders for the disc layout.');

  const record = (name, sector, length, isDir) => {
    const id = typeof name === 'string' ? Buffer.from(name, 'latin1') : name;
    const size = 33 + id.length + (id.length % 2 === 0 ? 1 : 0);
    const buf = Buffer.alloc(size);
    buf.writeUInt8(size, 0);
    both32(buf, 2, sector);
    both32(buf, 10, length);
    isoDate7(buf, 18, now);
    buf.writeUInt8(isDir ? 2 : 0, 25);
    both16(buf, 28, 1);
    buf.writeUInt8(id.length, 32);
    id.copy(buf, 33);
    return buf;
  };
  const self = Buffer.from([0]);
  const parent = Buffer.from([1]);

  const rootRecords = [
    record(self, isoDirSector.get('/'), SECTOR, true),
    record(parent, isoDirSector.get('/'), SECTOR, true),
    ...isoDirs.map((d) => record(d.name, isoDirSector.get(d.name), SECTOR, true)),
  ];
  const writeDir = (sector, records) => {
    const buf = blank();
    let at = 0;
    for (const r of records) {
      if (at + r.length > SECTOR) throw new Error('A folder has too many files for the disc layout.');
      r.copy(buf, at);
      at += r.length;
    }
    put(sector, buf);
  };
  writeDir(isoDirSector.get('/'), rootRecords);
  for (const dir of isoDirs) {
    const files = [...dir.files.map((f) => plan.files.find((p) => p.path === f.path))]
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    writeDir(isoDirSector.get(dir.name), [
      record(self, isoDirSector.get(dir.name), SECTOR, true),
      record(parent, isoDirSector.get('/'), SECTOR, true),
      ...files.map((f) => record(`${f.name};1`, f.size ? abs(f.block) : 0, f.size, false)),
    ]);
  }

  const pathTable = (bigEndian) => {
    const entries = [{ id: Buffer.from([0]), sector: isoDirSector.get('/'), parent: 1 }];
    for (const dir of isoDirs) entries.push({ id: Buffer.from(dir.name, 'latin1'), sector: isoDirSector.get(dir.name), parent: 1 });
    const parts = entries.map((e) => {
      const buf = Buffer.alloc(8 + e.id.length + (e.id.length % 2));
      buf.writeUInt8(e.id.length, 0);
      if (bigEndian) {
        buf.writeUInt32BE(e.sector, 2);
        buf.writeUInt16BE(e.parent, 6);
      } else {
        buf.writeUInt32LE(e.sector, 2);
        buf.writeUInt16LE(e.parent, 6);
      }
      e.id.copy(buf, 8);
      return buf;
    });
    return Buffer.concat(parts);
  };
  const lPath = pathTable(false);
  const mPath = pathTable(true);
  put(ISO_L_PATH, Buffer.concat([lPath, Buffer.alloc(SECTOR - lPath.length)]));
  put(ISO_M_PATH, Buffer.concat([mPath, Buffer.alloc(SECTOR - mPath.length)]));

  const pvd = blank();
  pvd.writeUInt8(1, 0);
  pvd.write('CD001', 1, 'latin1');
  pvd.writeUInt8(1, 6);
  padSpaces(pvd, 8, 32);
  padSpaces(pvd, 40, 32, isoLabel);
  both32(pvd, 80, plan.totalSectors);
  both16(pvd, 120, 1);
  both16(pvd, 124, 1);
  both16(pvd, 128, SECTOR);
  both32(pvd, 132, lPath.length);
  pvd.writeUInt32LE(ISO_L_PATH, 140);
  pvd.writeUInt32BE(ISO_M_PATH, 148);
  record(self, isoDirSector.get('/'), SECTOR, true).copy(pvd, 156);
  padSpaces(pvd, 190, 128, isoLabel);
  padSpaces(pvd, 318, 128);
  padSpaces(pvd, 446, 128);
  padSpaces(pvd, 574, 128, 'BURNHOUSE');
  padSpaces(pvd, 702, 37);
  padSpaces(pvd, 739, 37);
  padSpaces(pvd, 776, 37);
  isoDate17(pvd, 813, now);
  isoDate17(pvd, 830, now);
  isoDate17(pvd, 847, null);
  isoDate17(pvd, 864, null);
  pvd.writeUInt8(1, 881);
  put(ISO_PVD, pvd);

  const term = blank();
  term.writeUInt8(255, 0);
  term.write('CD001', 1, 'latin1');
  term.writeUInt8(1, 6);
  put(ISO_TERMINATOR, term);

  // ------------------------------------- UDF volume recognition sequence ---
  for (const [sector, id] of [[VRS_BEA, 'BEA01'], [VRS_NSR, 'NSR02'], [VRS_TEA, 'TEA01']]) {
    const buf = blank();
    buf.writeUInt8(0, 0);
    buf.write(id, 1, 'latin1');
    buf.writeUInt8(1, 6);
    put(sector, buf);
  }

  // ------------------------------------------- UDF volume descriptors ---
  const setId = `${Math.floor(now.getTime() / 1000).toString(16).toUpperCase().padStart(8, '0')}${'0'.repeat(8)}${udfLabel}`;

  const vds = (base) => {
    const out = [];
    let seq = 0;

    const primary = blank();
    primary.writeUInt32LE(seq++, 16);
    primary.writeUInt32LE(0, 20);
    dstring(primary, 24, 32, udfLabel);
    primary.writeUInt16LE(1, 56);
    primary.writeUInt16LE(1, 58);
    primary.writeUInt16LE(2, 60);
    primary.writeUInt16LE(3, 62);
    primary.writeUInt32LE(1, 64);
    primary.writeUInt32LE(1, 68);
    dstring(primary, 72, 128, setId);
    charspec(primary, 200);
    charspec(primary, 264);
    regid(primary, 344, IMPLEMENTATION);
    timestamp(primary, 376, now);
    regid(primary, 388, IMPLEMENTATION);
    tag(primary, 1, base + out.length, 512);
    out.push(primary);

    const iuvd = blank();
    iuvd.writeUInt32LE(seq++, 16);
    regid(iuvd, 20, '*UDF LV Info', udfSuffix);
    charspec(iuvd, 52);
    dstring(iuvd, 52 + 64, 128, udfLabel);
    regid(iuvd, 52 + 300, IMPLEMENTATION);
    tag(iuvd, 4, base + out.length, 512);
    out.push(iuvd);

    const partition = blank();
    partition.writeUInt32LE(seq++, 16);
    partition.writeUInt16LE(1, 20); // allocated
    partition.writeUInt16LE(0, 22); // partition number
    regid(partition, 24, '+NSR02');
    partition.writeUInt32LE(1, 184); // read only
    partition.writeUInt32LE(PARTITION_START, 188);
    partition.writeUInt32LE(plan.partitionLength, 192);
    regid(partition, 196, IMPLEMENTATION);
    tag(partition, 5, base + out.length, 512);
    out.push(partition);

    const logical = blank();
    logical.writeUInt32LE(seq++, 16);
    charspec(logical, 20);
    dstring(logical, 84, 128, udfLabel);
    logical.writeUInt32LE(SECTOR, 212);
    regid(logical, 216, '*OSTA UDF Compliant', [UDF_REVISION & 0xff, UDF_REVISION >> 8, 0]);
    longAd(logical, 248, SECTOR, 0); // the File Set Descriptor
    logical.writeUInt32LE(6, 264); // map table length
    logical.writeUInt32LE(1, 268); // one partition map
    regid(logical, 272, IMPLEMENTATION);
    logical.writeUInt32LE(2 * SECTOR, 432); // integrity sequence: LVID + terminator
    logical.writeUInt32LE(UDF_LVID, 436);
    logical.writeUInt8(1, 440); // type 1 partition map
    logical.writeUInt8(6, 441);
    logical.writeUInt16LE(1, 442); // volume sequence number
    logical.writeUInt16LE(0, 444); // partition number
    tag(logical, 6, base + out.length, 446);
    out.push(logical);

    const unallocated = blank();
    unallocated.writeUInt32LE(seq++, 16);
    unallocated.writeUInt32LE(0, 20);
    tag(unallocated, 7, base + out.length, 24);
    out.push(unallocated);

    const terminator = blank();
    tag(terminator, 8, base + out.length, 512);
    out.push(terminator);

    out.forEach((buf, i) => put(base + i, buf));
  };
  vds(UDF_MAIN_VDS);
  vds(UDF_RESERVE_VDS);

  // ------------------------------------------------ files and folders ---
  let uniqueId = 16;
  const ids = new Map();
  const idFor = (key) => {
    if (!ids.has(key)) ids.set(key, uniqueId++);
    return ids.get(key);
  };

  const fid = (name, feBlock, characteristics, id) => {
    const nameBytes = name === null ? Buffer.alloc(0) : Buffer.concat([Buffer.from([8]), Buffer.from(name, 'latin1')]);
    const raw = 38 + nameBytes.length;
    const size = raw + ((4 - (raw % 4)) % 4);
    const buf = Buffer.alloc(size);
    buf.writeUInt16LE(1, 16); // file version
    buf.writeUInt8(characteristics, 18);
    buf.writeUInt8(nameBytes.length, 19);
    longAd(buf, 20, SECTOR, feBlock, id);
    buf.writeUInt16LE(0, 36);
    nameBytes.copy(buf, 38);
    return buf;
  };
  const DIRECTORY = 0x02;
  const PARENT = 0x08;

  const fileEntry = ({ block, type, size, extents, links, id }) => {
    const buf = blank();
    // ICB tag
    buf.writeUInt32LE(0, 16);
    buf.writeUInt16LE(4, 20); // strategy 4
    buf.writeUInt16LE(1, 24); // max entries
    buf.writeUInt8(type, 27); // 4 directory, 5 file
    buf.writeUInt16LE(0, 34); // short allocation descriptors
    buf.writeUInt32LE(0xffffffff, 36); // uid
    buf.writeUInt32LE(0xffffffff, 40); // gid
    // Read (and for folders, search) for owner, group and everyone.
    buf.writeUInt32LE(type === 4 ? 0x14a5 : 0x1084, 44);
    buf.writeUInt16LE(links, 48);
    buf.writeBigUInt64LE(BigInt(size), 56);
    const recorded = extents.reduce((sum, e) => sum + sectorsOf(e.length), 0);
    buf.writeBigUInt64LE(BigInt(recorded), 64);
    timestamp(buf, 72, now);
    timestamp(buf, 84, now);
    timestamp(buf, 96, now);
    buf.writeUInt32LE(1, 108); // checkpoint
    regid(buf, 128, IMPLEMENTATION);
    buf.writeBigUInt64LE(BigInt(id), 160);
    buf.writeUInt32LE(0, 168);
    buf.writeUInt32LE(extents.length * 8, 172);
    extents.forEach((e, i) => {
      buf.writeUInt32LE(e.length, 176 + i * 8);
      buf.writeUInt32LE(e.block, 180 + i * 8);
    });
    const length = 176 + extents.length * 8;
    if (length > SECTOR) throw new Error('A file is too large to describe on the disc.');
    tag(buf, 261, block, length);
    put(abs(block), buf);
  };

  const extentsFor = (startBlock, size) => {
    const out = [];
    let remaining = size;
    let at = startBlock;
    while (remaining > 0) {
      const length = Math.min(remaining, MAX_EXTENT);
      out.push({ length, block: at });
      at += sectorsOf(length);
      remaining -= length;
    }
    return out;
  };

  const directory = ({ feBlock, dataBlock, parentFe, parentId, children, id, links }) => {
    const parts = [fid(null, parentFe, DIRECTORY | PARENT, parentId)];
    for (const child of children) parts.push(fid(child.name, child.feBlock, child.isDir ? DIRECTORY : 0, child.id));
    const data = Buffer.concat(parts);
    if (data.length > SECTOR) throw new Error('A folder has too many files for the disc layout.');
    // Every FID tag records the block it sits in.
    let at = 0;
    const out = blank();
    for (const part of parts) {
      tag(part, 257, dataBlock);
      part.copy(out, at);
      at += part.length;
    }
    put(abs(dataBlock), out);
    fileEntry({ block: feBlock, type: 4, size: data.length, extents: [{ length: data.length, block: dataBlock }], links, id });
  };

  const rootId = 0; // the root's unique id is zero
  directory({
    feBlock: plan.root.feBlock,
    dataBlock: plan.root.dataBlock,
    parentFe: plan.root.feBlock,
    parentId: rootId,
    children: plan.dirs.map((d) => ({ name: d.name, feBlock: d.feBlock, isDir: true, id: idFor(d.name) })),
    id: rootId,
    links: 1 + plan.dirs.length,
  });

  for (const dir of plan.dirs) {
    const children = dir.files
      .map((f) => plan.files.find((p) => p.path === f.path))
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((f) => ({ name: f.name, feBlock: f.feBlock, isDir: false, id: idFor(f.path) }));
    directory({
      feBlock: dir.feBlock,
      dataBlock: dir.dataBlock,
      parentFe: plan.root.feBlock,
      parentId: rootId,
      children,
      id: idFor(dir.name),
      links: 1,
    });
  }

  for (const file of plan.files) {
    fileEntry({
      block: file.feBlock,
      type: 5,
      size: file.size,
      extents: extentsFor(file.block, file.size),
      links: 1,
      id: idFor(file.path),
    });
  }

  // File Set Descriptor and its terminator, at the start of the partition.
  const fsd = blank();
  timestamp(fsd, 16, now);
  fsd.writeUInt16LE(3, 28);
  fsd.writeUInt16LE(3, 30);
  fsd.writeUInt32LE(1, 32);
  fsd.writeUInt32LE(1, 36);
  charspec(fsd, 48);
  dstring(fsd, 112, 128, udfLabel);
  charspec(fsd, 240);
  dstring(fsd, 304, 32, udfLabel);
  longAd(fsd, 400, SECTOR, plan.root.feBlock, rootId);
  regid(fsd, 416, '*OSTA UDF Compliant', [UDF_REVISION & 0xff, UDF_REVISION >> 8, 0]);
  tag(fsd, 256, 0, 512);
  put(abs(0), fsd);
  const fsdTerm = blank();
  tag(fsdTerm, 8, 1, 512);
  put(abs(1), fsdTerm);

  // ------------------------------------------------ integrity, anchors ---
  const lvid = blank();
  timestamp(lvid, 16, now);
  lvid.writeUInt32LE(1, 28); // closed
  lvid.writeBigUInt64LE(BigInt(uniqueId), 40); // next unique id
  lvid.writeUInt32LE(1, 72); // partitions
  lvid.writeUInt32LE(46, 76); // implementation use length
  lvid.writeUInt32LE(0, 80); // free space
  lvid.writeUInt32LE(plan.partitionLength, 84); // size
  regid(lvid, 88, IMPLEMENTATION);
  lvid.writeUInt32LE(plan.files.length, 120);
  lvid.writeUInt32LE(plan.dirs.length + 1, 124);
  lvid.writeUInt16LE(UDF_REVISION, 128);
  lvid.writeUInt16LE(UDF_REVISION, 130);
  lvid.writeUInt16LE(UDF_REVISION, 132);
  tag(lvid, 9, UDF_LVID, 134);
  put(UDF_LVID, lvid);
  const lvidTerm = blank();
  tag(lvidTerm, 8, UDF_LVID + 1, 512);
  put(UDF_LVID + 1, lvidTerm);

  const anchor = (sector) => {
    const buf = blank();
    buf.writeUInt32LE(UDF_VDS_LENGTH * SECTOR, 16);
    buf.writeUInt32LE(UDF_MAIN_VDS, 20);
    buf.writeUInt32LE(UDF_VDS_LENGTH * SECTOR, 24);
    buf.writeUInt32LE(UDF_RESERVE_VDS, 28);
    tag(buf, 2, sector, 512);
    put(sector, buf);
  };
  anchor(UDF_AVDP);
  anchor(plan.totalSectors - 1);

  return sectors;
}

/**
 * Write the image.
 *
 * The file is sized first, then everything is written into it in ascending
 * order — tables, file data, and the closing anchor last. The order matters on
 * Windows: NTFS zero-fills everything below a write past the end of what has
 * been written so far, so writing the final anchor first would mean writing the
 * whole disc twice. Any gap the IFOs ask for is simply never written, which
 * reads back as zeros, which is what it must be.
 */
async function writeDvdImage({ sourceDir, outputIso, volumeLabel, onProgress, signal }) {
  const plan = planImage({ sourceDir, volumeLabel });
  const structures = buildStructures(plan);

  const writes = [
    ...[...structures].map(([sector, buf]) => ({ sector, buf })),
    ...plan.files.filter((f) => f.size).map((file) => ({ sector: PARTITION_START + file.block, file })),
  ].sort((a, b) => a.sector - b.sector);

  fs.mkdirSync(path.dirname(outputIso), { recursive: true });
  const temp = `${outputIso}.partial`;
  fs.rmSync(temp, { force: true });

  const fh = await fs.promises.open(temp, 'w');
  const totalData = plan.files.reduce((sum, f) => sum + f.size, 0) || 1;
  let copied = 0;
  let lastReport = 0;
  try {
    await fh.truncate(plan.totalBytes);

    /*
      Big chunks, and the next read already under way while the last one is
      being written: this is a few gigabytes of sequential copying, and keeping
      both the read and the write busy at once is most of the difference
      between seconds and minutes.
    */
    const CHUNK = 8 * 1024 * 1024;
    const buffers = [Buffer.allocUnsafe(CHUNK), Buffer.allocUnsafe(CHUNK)];
    for (const item of writes) {
      if (item.buf) {
        await fh.write(item.buf, 0, item.buf.length, item.sector * SECTOR);
        continue;
      }
      const { file } = item;
      const src = await fs.promises.open(file.path, 'r');
      try {
        const readAt = (offset, buffer) =>
          src.read(buffer, 0, Math.min(CHUNK, file.size - offset), offset).then(({ bytesRead }) => {
            if (!bytesRead) throw new Error(`${file.name} became shorter while the disc image was being built.`);
            return bytesRead;
          });
        let offset = 0;
        let turn = 0;
        let reading = readAt(0, buffers[0]);
        while (offset < file.size) {
          if (signal && signal.aborted) throw new AbortError('Building the disc image was stopped.');
          const bytesRead = await reading;
          const buffer = buffers[turn];
          const next = offset + bytesRead;
          turn ^= 1;
          reading = next < file.size ? readAt(next, buffers[turn]) : null;
          // Kept from becoming an unhandled rejection while the write runs.
          if (reading) reading.catch(() => {});
          await fh.write(buffer, 0, bytesRead, item.sector * SECTOR + offset);
          offset = next;
          copied += bytesRead;
          const now = Date.now();
          if (onProgress && now - lastReport > 250) {
            lastReport = now;
            onProgress(Math.min(0.99, copied / totalData));
          }
        }
      } finally {
        await src.close();
      }
    }
  } catch (err) {
    await fh.close().catch(() => {});
    fs.rmSync(temp, { force: true });
    throw err;
  }
  await fh.close();

  fs.rmSync(outputIso, { force: true });
  fs.renameSync(temp, outputIso);
  if (onProgress) onProgress(1);

  return {
    isoPath: outputIso,
    bytes: plan.totalBytes,
    sectors: plan.totalSectors,
    dvdCompliant: plan.dvdCompliant,
  };
}

module.exports = {
  writeDvdImage,
  planImage,
  planDvdLayout,
  plainDvdOrder,
  buildStructures,
  crc16,
  SECTOR,
};
