'use strict';

/**
 * Everything that touches real hardware: finding writers, building an ISO, and
 * burning it.
 *
 * Both platforms are driven through the operating system's own optical writer
 * support — `drutil` and `hdiutil` on macOS, IMAPI2 on Windows. That matters
 * more than it sounds: DVD Styler's burn problems come from linking against
 * third-party burning libraries that rot against new OS releases. The system
 * tools cannot fall out of step with the system.
 */

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { isMac, isWindows } = require('./tools');
const windowsDisc = require('./disc_windows');
const dvdImage = require('./dvd_image');
const { AbortError } = require('./encode');

/**
 * The revision of the disc image format. Part of the stamp an image is reused
 * by, so a change to how images are made cannot be skipped by an old image.
 *
 *   1  hdiutil makehybrid / IMAPI
 *   2  dvd_image.js: UDF 1.02 + ISO 9660, files where the IFOs say they are
 */
const IMAGE_REVISION = 2;

const exec = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 60000, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = String(stdout || '');
        err.stderr = String(stderr || '');
        return reject(err);
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });

/**
 * List optical writers.
 *
 * `drutil list` output looks like:
 *
 *   Vendor   Product           Rev   Bus           SupportLevel             DeviceNode
 *   HL-DT-ST DVDRAM GP65NB60   PF00  USB   Apple Shipping                 /dev/disk4
 *
 * The SupportLevel column is what tells us whether it can actually write.
 * An external USB writer on a 2017 MacBook Air lands here; the machine has no
 * internal drive at all.
 *
 * The columns are read by position, taken from the header line, because every
 * field can contain spaces — "DVDRAM GP65NB60" is one product name, and
 * "Apple Supported" is one support level. Splitting on whitespace and counting
 * back from the end gets both wrong: it reported the bus as "Apple" and the
 * product as "DVDRAM GP65NB60 DH61 USB", and then refused the drive because the
 * support level it compared against was the wrong word entirely.
 */
const DRUTIL_COLUMNS = ['Vendor', 'Product', 'Rev', 'Bus', 'SupportLevel'];

function drutilColumnStarts(headerLine) {
  const starts = [];
  for (const name of DRUTIL_COLUMNS) {
    const at = headerLine.indexOf(name);
    if (at === -1) return null;
    starts.push({ name, at });
  }
  // The columns have to be in the order drutil prints them, or the slices below
  // would cut across fields.
  for (let i = 1; i < starts.length; i += 1) {
    if (starts[i].at <= starts[i - 1].at) return null;
  }
  return starts;
}

/** One `drutil list` row, cut into its columns by the header's own positions. */
function parseDrutilRow(line, starts) {
  if (!starts || !starts.length) return {};
  const field = {};
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i].at;
    const to = i + 1 < starts.length ? starts[i + 1].at : line.length;
    field[starts[i].name] = line.slice(from, to).trim();
  }
  return field;
}

/**
 * Pull the drive records out of `drutil list -xml`.
 *
 * This is the form to use. The plain output is a fixed-width table whose
 * columns move between macOS versions and whose fields can each contain spaces,
 * so parsing it means guessing — and guessing wrong meant a burner that was
 * plugged in and working was reported as absent.
 *
 * The man page documents `-xml` for list, info, status, discinfo and trackinfo
 * for exactly this reason. Each drive arrives as a <dict> of key/value pairs,
 * which is unambiguous.
 */
/**
 * Pull a BSD device node out of whatever a plist field happens to contain.
 *
 * The node has appeared as "/dev/disk5", as a bare "disk5", and inside a longer
 * IOKit path. Anything that names a disk is taken, and normalised to the /dev
 * form the burn command wants.
 */
function bsdDeviceNode(value) {
  const text = String(value || '');
  const direct = /\/dev\/(?:r)?(disk\d+)/.exec(text);
  if (direct) return `/dev/${direct[1]}`;
  const bare = /(?:^|[^A-Za-z0-9])(disk\d+)(?![0-9])/.exec(text);
  if (bare) return `/dev/${bare[1]}`;
  return '';
}

function parseDrutilXml(xml) {
  const text = String(xml || '');
  if (!/<deviceList|<device/i.test(text)) return [];

  // Just match the attribute in the tag text, e.g. name="hp" in <vendor name="hp"/>.
  const attr = (tagText, name) => {
    if (!tagText) return '';
    const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tagText);
    return m ? m[1].trim() : '';
  };

  /*
    The tag name has to be interpolated, so this is RegExp() and not a literal.

    Writing `/<${tag}\b.../` looks like interpolation and is not: a regex literal
    matches those characters verbatim, so it searched for a literal "<${tag}" and
    found nothing, in every device, on every Mac.
  */
  const tagFor = (body, tag) => {
    const m = new RegExp(`<${tag}\\b[^>]*/?>`, 'i').exec(body);
    return m ? m[0] : '';
  };

  const drives = [];
  const deviceRe = /<device\b([^>]*)>([\s\S]*?)<\/device>/gi;
  let match;

  while ((match = deviceRe.exec(text))) {
    const body = match[2];

    const vendor = attr(tagFor(body, 'vendor'), 'name');
    const product = attr(tagFor(body, 'product'), 'name');
    const revision = attr(tagFor(body, 'firmware'), 'revision');
    const bus = attr(tagFor(body, 'interconnect'), 'name');
    const support = attr(tagFor(body, 'support'), 'level');

    /*
      The support levels are appleShipping, appleSupported, vendorSupported,
      unSupported and notSupported.

      Only the last two are a refusal. `vendorSupported` is a third-party drive
      macOS knows how to write to, and treating an unfamiliar spelling as a
      refusal is what hid this drive for several rounds: drutil listed it, the
      app disagreed, and the page said no burner was attached.
    */
    // NOT a reason to hide the drive. This very drive reports `unSupported` and
    // still burns: hdiutil is the authority, and a burn that cannot proceed
    // fails before writing anything. Gating on this is what greyed out the Burn
    // button for a writer that works.

    drives.push({
      // drutil does not name a device node at all, so the index it does give is
      // the only thing to identify a drive by.
      id: attr(/<device\b([^>]*)>/i.exec(match[0])?.[0] || '', 'index') || `drutil-${drives.length + 1}`,
      device: '',
      vendor,
      product,
      rev: revision,
      bus,
      supportLevel: support,
      writeCapable: true,
      label: [vendor, product].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || 'Disc writer',
    });
  }

  return drives;
}

/**
 * Read the burner list that `hdiutil burn -list` prints.
 *
 * This is the enumeration that matters on macOS. `hdiutil burn -device` takes
 * the DiscRecording IORegistry entry path — an "IOService:/..." string — and NOT
 * a BSD node like /dev/disk5.
 *
 * That distinction is the likely reason burning failed on a Mac where DVDStyler
 * burns the same drive happily: its source builds
 * `hdiutil burn -device "<IORegistryEntryPath>" "<file.iso>"`, and it never
 * passes a BSD node. "SupportLevel: Unsupported" is advisory metadata and does
 * not stop hdiutil.
 */
function parseHdiutilBurnList(stdout) {
  const text = String(stdout || '');
  const drives = [];
  const seen = new Set();

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const at = line.indexOf('IOService:');
    if (at === -1) continue;

    // The path runs to the end of the line, because it ends with the drive's own
    // name and that name contains spaces: ".../IOBlockStorageDriver/hp DVDRW
    // DU8A6SH Medium". Cutting at the first space would truncate it.
    const path = line.slice(at);
    if (seen.has(path)) continue;
    seen.add(path);

    // Anything before the path on the same line describes the drive.
    const lead = line.slice(0, at).replace(/\s+/g, ' ').trim();

    drives.push({
      id: path,
      device: path,
      vendor: '',
      product: lead,
      rev: '',
      bus: '',
      supportLevel: '',
      writeCapable: true,
      label: lead || 'Disc writer',
    });
  }

  return drives;
}

/**
 * Read the "Key: value" listing that some versions of drutil produce.
 *
 * A real Mac reported its writer as one line of labelled fields —
 * "Vendor: … Product: … Rev: … Bus: … SupportLevel: …" — rather than the
 * fixed-width table, and neither the table parser nor the XML parser could make
 * anything of it. The result was an app that said no burner was attached while
 * one sat plugged in and DVDStyler was happily burning to it.
 *
 * This reads whatever labelled fields are present, in any arrangement, and does
 * not require a device node: hdiutil picks the only attached writer itself, so a
 * drive with no node is still perfectly usable.
 */
function parseDrutilKeyValues(stdout) {
  const text = String(stdout || '');
  if (!/Vendor\s*:/i.test(text) && !/SupportLevel\s*:/i.test(text)) return [];

  const LABELS = [
    'Vendor', 'Product', 'Revision', 'Rev', 'Bus', 'Protocol',
    'SupportLevel', 'DeviceNode', 'BSDName', 'IOBSDName',
  ];
  const labelRe = new RegExp(`(${LABELS.join('|')})\\s*:`, 'gi');

  const marks = [];
  let m;
  while ((m = labelRe.exec(text))) {
    marks.push({ label: m[1], at: m.index, after: labelRe.lastIndex });
  }
  if (!marks.length) return [];

  // Records are separated by each new "Vendor", so several drives in one blob
  // are read as several drives rather than merged into one.
  const records = [];
  let current = null;
  for (let i = 0; i < marks.length; i += 1) {
    const to = i + 1 < marks.length ? marks[i + 1].at : text.length;
    const value = text.slice(marks[i].after, to).trim();
    const isVendor = /^vendor$/i.test(marks[i].label);

    if (isVendor || !current) {
      current = {};
      records.push(current);
    }
    // First value wins, so a repeated label does not overwrite a real one.
    if (!(marks[i].label in current)) current[marks[i].label] = value;
  }

  const pick = (record, ...names) => {
    for (const name of names) {
      const key = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase());
      if (key && record[key]) return record[key];
    }
    return '';
  };

  return records
    .filter((record) => Object.keys(record).length)
    .map((record, index) => {
      let node = bsdDeviceNode(pick(record, 'DeviceNode', 'BSDName', 'IOBSDName'));
      if (!node) {
        for (const value of Object.values(record)) {
          node = bsdDeviceNode(value);
          if (node) break;
        }
      }

      const vendorField = pick(record, 'Vendor');
      const product = pick(record, 'Product');
      const support = pick(record, 'SupportLevel');
      // One Mac reports "Vendor: 1", where the value is plainly not a vendor
      // name. Dropping it keeps the label readable rather than prefixing every
      // drive with a stray number.
      const vendor = /^\d+$/.test(vendorField.trim()) ? '' : vendorField;

      return {
        // Never empty: the UI selects drives by this, and an empty one made the
        // Burn button think no drive was chosen.
        id: node || `drutil-${index + 1}`,
        device: node,
        vendor,
        product,
        rev: pick(record, 'Revision', 'Rev'),
        bus: pick(record, 'Bus', 'Protocol'),
        supportLevel: support,
        writeCapable: true,
        label: [vendor, product].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || 'Disc writer',
      };
    });
}

/**
 * Turn the raw output of `drutil list` into drive records.
 *
 * Kept as the fallback for when the XML form is unavailable, and separated out
 * so it can be tested against real output from a Mac without a Mac and without
 * a drive attached.
 */
function parseDrutilList(stdout) {
  const drives = [];
  const lines = String(stdout || '').split('\n');
  const headerLine = lines.find((l) => /Vendor\s+Product/i.test(l)) || '';
  // Null when the header is not the shape we know. Without one there is no way
  // to tell a drive row from a line of prose — "No drives found" was being read
  // as a drive called "found" — so this gives up rather than inventing one. The
  // XML form above is the one that matters; this is only a fallback.
  const starts = drutilColumnStarts(headerLine);
  if (!starts) return drives;

  for (const line of lines) {
    // The real table has no DeviceNode column at all:
    //   Vendor   Product           Rev   Bus       SupportLevel
    // so a row is recognised by its shape, not by a device path that is never
    // there. Requiring /dev/diskN matched nothing, on any Mac, ever.
    if (/^\s*Vendor\s+Product/i.test(line)) continue;
    if (!/\S/.test(line)) continue;

    // Rows start with the vendor; anything indented past the header's own
    // "Vendor" column but carrying text is a drive.
    const fields = starts ? parseDrutilRow(line, starts) : null;
    const support = fields ? fields.SupportLevel || '' : (/(\S+)\s*$/.exec(line.trim()) || [])[1] || '';
    const vendor = fields ? fields.Vendor || '' : line.trim().split(/\s+/)[0] || '';
    const product = fields ? fields.Product || '' : '';

    // A header row has no support level worth the name, and a stray line of
    // prose is not a drive.
    if (!vendor || /^Vendor$/i.test(vendor)) continue;
    if (!support && !product) continue;

    // NOT a reason to hide the drive. This very drive reports `unSupported` and
    // still burns: hdiutil is the authority, and a burn that cannot proceed
    // fails before writing anything. Gating on this is what greyed out the Burn
    // button for a writer that works.

    drives.push({
      id: vendor + (product ? ` ${product}` : ''),
      device: '',
      vendor,
      product,
      rev: fields ? fields.Rev || '' : '',
      bus: fields ? fields.Bus || '' : '',
      supportLevel: support,
      writeCapable: true,
      label: [vendor, product].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || vendor,
    });
  }

  // Nothing from the table either: the labelled form is the last shape seen in
  // the wild, so try that before giving up on a drive that may be right there.
  if (!drives.length) {
    drives.push(...parseDrutilKeyValues(stdout));
  }

  return drives;
}

async function listDrives({ drutil, hdiutil, diskutil } = {}) {
  if (isWindows) return windowsDisc.listDrives();
  if (!isMac) return { supported: false, drives: [], note: 'Burning discs needs Windows or macOS.' };

  const drives = [];
  // Kept and returned so Setup can show it. If a burner is plugged in and still
  // is not listed, this is the only thing that says why.
  let raw = '';

  /*
    Ask hdiutil first, because its device paths are the ones `hdiutil burn`
    accepts. drutil knows drives hdiutil will not name, so it is still consulted
    when hdiutil offers nothing — but a drive discovered that way has no usable
    device path, and the burn is then told to use the only attached writer
    instead of being handed a node hdiutil would reject.
  */
  if (hdiutil) {
    try {
      const { stdout } = await exec(hdiutil, ['burn', '-list']);
      raw = stdout;
      drives.push(...parseHdiutilBurnList(stdout));
    } catch {
      // Not every version supports it; drutil below is the fallback.
    }
  }

  if (!drives.length && drutil) {
    try {
      // The XML form first, because it is unambiguous.
      const { stdout } = await exec(drutil, ['list', '-xml']);
      raw = stdout;
      drives.push(...parseDrutilXml(stdout));

      if (!drives.length) {
        // Either this drutil does not know -xml, or it found no drives. Ask for
        // the plain listing too, and keep whichever is more informative.
        const plain = await exec(drutil, ['list']);
        if (plain.stdout.trim()) {
          raw = `${raw}\n\n--- drutil list ---\n${plain.stdout}`;
          drives.push(...parseDrutilList(plain.stdout));
        }
      }
    } catch (err) {
      // -xml refused: fall back to the text listing rather than giving up.
      try {
        const { stdout } = await exec(drutil, ['list']);
        raw = stdout;
        drives.push(...parseDrutilList(stdout));
      } catch (inner) {
        return {
          supported: true,
          drives: [],
          raw,
          note: 'The drive list could not be read. Connect the burner and try again.',
          error: String(inner.message || inner),
        };
      }
    }
  }

  // Ask about the disc in each drive, so the app can say "there is no disc" or
  // "that one already has something on it" BEFORE hdiutil is handed a disc it
  // will not use. Without this the first sign of trouble is the tray opening,
  // which says nothing about why.
  //
  // `drutil status -drive` takes a BSD node or a 1-based index into drutil's own
  // list. Drives found through hdiutil have an IORegistry path instead, so those
  // are asked for by position. With one drive attached — the usual case, and the
  // one reported — the position is unambiguous.
  for (let i = 0; i < drives.length; i += 1) {
    const drive = drives[i];
    if (!drutil) continue;
    const target = /^\/dev\//.test(drive.device || '') ? drive.device : String(i + 1);
    try {
      const { stdout } = await exec(drutil, ['status', '-drive', target]);
      drive.media = summariseMedia(stdout);

      // drutil often omits the capacity, which left the page saying "capacity
      // unknown" for a disc sitting right there. diskutil knows.
      if (drive.media.present && !drive.media.capacity) {
        const extra = await capacityFromDiskutil(diskutil, drive.media.node);
        if (extra) {
          drive.media.capacity = drive.media.capacity || extra.capacity;
          drive.media.freeSpace = drive.media.freeSpace || extra.freeSpace;
        }
      }
    } catch {
      drive.media = { present: false, raw: '' };
    }
  }

  return { supported: true, drives, raw, note: null };
}

function summariseMedia(output) {
  const text = String(output || '');
  const present = /Type:\s*(?!No Media)/i.test(text) && !/No Media/i.test(text);
  /*
    Written against what drutil actually prints on macOS 12.7.6 with a disc in it:

             Type: DVD-R                Name: /dev/disk2
         Sessions: 1                  Tracks: 1
       Space Free:   00:00:00         blocks: 0 /   0.00MB /   0.00MiB
       Space Used:   01:27:67         blocks: 6592 /  13.50MB /  12.88MiB
        Book Type: DVD-R (v5)

    Three things had been guessed wrong, which is why the app said "capacity
    unknown" for a disc sitting in front of it: the field is "Space Free" and not
    "Free Space"; the device name shares a line with Type rather than starting
    one; and the figures are MB inside a line that also carries a timecode.
  */
  const typeMatch = /Type:\s*([^\n]*?)(?:\s{2,}Name:|\s*$)/im.exec(text);
  const nodeMatch = /Name:\s*(\/dev\/\w+)/i.exec(text);
  const sessionsMatch = /Sessions:\s*(\d+)/i.exec(text);
  const bookMatch = /Book Type:\s*(.+)/i.exec(text);
  const erasableMatch = /Erasable:\s*(Yes|No|TRUE|FALSE)/i.exec(text);
  const appendableMatch = /Appendable:\s*(Yes|No|TRUE|FALSE)/i.exec(text);

  /*
    The value's unit depends on its size, which cost another round: a blank disc
    reports "4.71GB", a part-written one "13.50MB" — same field, different units.
    Matching only MB left a fresh disc saying "capacity unknown", which is the
    exact complaint this fixes.
  */
  const sizeOf = (line) => {
    if (!line) return null;
    const gb = /([\d.]+)\s*GB/i.exec(line);
    if (gb) return Number(gb[1]) * 1024;
    const mb = /([\d.]+)\s*MB/i.exec(line);
    return mb ? Number(mb[1]) : null;
  };
  const freeMb = sizeOf(/Space Free:\s*(.+)/i.exec(text)?.[1]);
  const usedMb = sizeOf(/Space Used:\s*(.+)/i.exec(text)?.[1]);
  const sessions = sessionsMatch ? Number(sessionsMatch[1]) : null;

  // drutil says so outright on a blank disc: "Writability: appendable, blank,
  // overwritable". It prints an empty Writability line once a disc is written.
  const writability = /Writability:\s*([^\n]*)/i.exec(text)?.[1]?.trim() || '';
  const saysBlank = /\bblank\b/i.test(writability);

  /*
    Blank means never written to. A disc carrying a session, or with no room
    left, is not blank — worth saying before a burn rather than after the tray
    has opened. An explicit "blank" from drutil settles it either way.
  */
  const alreadyWritten = saysBlank
    ? false
    : (sessions !== null && sessions > 0) || (freeMb !== null && freeMb <= 0);
  const totalMb = freeMb === null && usedMb === null ? null : (freeMb || 0) + (usedMb || 0);
  // MB below a gigabyte, GB above: "0.01 GB used" is a worse way of saying
  // "13.5 MB used", and a written disc reports in MB.
  const size = (mb) => (mb === null ? null : mb < 1024 ? `${mb.toFixed(1)} MB` : `${(mb / 1024).toFixed(2)} GB`);

  return {
    present,
    type: typeMatch ? typeMatch[1].trim() : null,
    node: nodeMatch ? nodeMatch[1].trim() : null,
    sessions,
    bookType: bookMatch ? bookMatch[1].trim() : null,
    erasable: erasableMatch ? /yes|true/i.test(erasableMatch[1]) : null,
    appendable: appendableMatch ? /yes|true/i.test(appendableMatch[1]) : null,
    overWritable: null,
    freeMb,
    usedMb,
    capacityMb: totalMb,
    freeSpace: freeMb === null ? null : `${size(freeMb)} free`,
    usedSpace: usedMb === null ? null : `${size(usedMb)} used`,
    /*
      The disc's nominal size when drutil gives none. It reports nothing for some
      blank discs and for a disc that has just been closed, and "capacity unknown"
      for a disc whose type is printed right beside it is a worse answer than the
      size on its packaging.
    */
    capacity:
      totalMb === null || totalMb <= 0
        ? (/DL|dual|double/i.test(String(typeMatch && typeMatch[1])) ? '8.5 GB'
          : /DVD/i.test(String(typeMatch && typeMatch[1])) ? '4.7 GB'
          : /CD/i.test(String(typeMatch && typeMatch[1])) ? '700 MB' : null)
        : size(totalMb),
    alreadyWritten,
    raw: text,
  };
}

/**
 * How much room is on the disc, according to the system's own disk utility.
 *
 * `drutil status` does not always report a capacity, and the Finish page showed
 * "capacity unknown" for a disc that was plainly in the drive. diskutil knows
 * the size of any inserted disc, so it is asked directly.
 */
async function capacityFromDiskutil(diskutil, node) {
  if (!diskutil || !node) return null;
  try {
    const { stdout } = await exec(diskutil, ['info', node]);
    const size =
      /Volume Free Space:\s*(.+)/i.exec(stdout) ||
      /Disk Size:\s*(.+)/i.exec(stdout) ||
      /Total Size:\s*(.+)/i.exec(stdout);
    const free = /Volume Free Space:\s*(.+)/i.exec(stdout);
    return {
      freeSpace: free ? free[1].trim() : null,
      capacity: size ? size[1].trim() : null,
    };
  } catch {
    return null;
  }
}

/**
 * Build a DVD-Video disc image from the folder that holds VIDEO_TS.
 *
 * Written by dvd_image.js on both platforms, because it is the only one of the
 * available tools that puts the files where the IFOs say they are — see the
 * note at the top of that file. The system tools remain as a fallback for
 * anything it cannot handle, so a disc can still be made, just a less exact
 * one, and the log says so.
 */
async function buildIso({ sourceDir, outputIso, volumeLabel, hdiutil, mkisofs, onProgress, signal, log }) {
  fs.mkdirSync(path.dirname(outputIso), { recursive: true });

  let ownError;
  try {
    const result = await dvdImage.writeDvdImage({ sourceDir, outputIso, volumeLabel, onProgress, signal });
    if (!result.dvdCompliant && log) {
      log('The disc tables could not be read, so the files were laid out in the usual order instead.');
    }
    return result;
  } catch (err) {
    if (err && err.isAbort) throw err;
    if (signal && signal.aborted) throw new AbortError('Building the disc image was stopped.');
    ownError = err;
  }
  if (log) log(`The disc image could not be written directly (${ownError.message}); using the system's tool instead.`);

  fs.rmSync(outputIso, { force: true });
  if (isWindows) return windowsDisc.buildIso({ sourceDir, outputIso, volumeLabel, signal });
  if (hdiutil) return buildIsoHdiutil({ sourceDir, outputIso, volumeLabel, hdiutil, onProgress, signal });
  if (mkisofs) return buildIsoMkisofs({ sourceDir, outputIso, volumeLabel, mkisofs, onProgress, signal });
  throw ownError;
}

function buildIsoHdiutil({ sourceDir, outputIso, volumeLabel, hdiutil, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    // UDF 1.02 is the version the DVD-Video specification names; hdiutil's own
    // choice is not documented, so it is stated.
    const args = [
      'makehybrid',
      '-o', outputIso,
      '-udf',
      '-udf-version', '1.02',
      '-udf-volume-name', volumeLabel || 'MY_DVD',
      '-default-volume-name', volumeLabel || 'MY_DVD',
      sourceDir,
    ];

    const child = spawn(hdiutil, args, { windowsHide: true });
    let out = '';

    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (c) => {
      out += c.toString();
    });
    child.stderr.on('data', (c) => {
      out += c.toString();
    });

    child.on('error', (err) => reject(new Error(`Could not build the disc image: ${err.message}`)));

    child.on('close', (code) => {
      if (signal && signal.aborted) return reject(new AbortError('Building the disc image was stopped.'));
      if (code !== 0) {
        return reject(new Error(describeIsoFailure(out)));
      }
      if (onProgress) onProgress(1);
      resolve({ isoPath: outputIso, log: out });
    });
  });
}

function buildIsoMkisofs({ sourceDir, outputIso, volumeLabel, mkisofs, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    // `-dvd-video` lays the files out where the IFOs expect them.
    const args = [
      '-dvd-video',
      '-udf',
      '-V', volumeLabel || 'MY_DVD',
      '-o', outputIso,
      sourceDir,
    ];

    const child = spawn(mkisofs, args, { windowsHide: true });
    let out = '';

    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (c) => {
      out += c.toString();
      // mkisofs reports percentage on stderr; either way, look for a number.
      const m = /(\d{1,3})%/.exec(c.toString());
      if (m && onProgress) onProgress(Math.min(1, Number(m[1]) / 100));
    });
    child.stderr.on('data', (c) => {
      out += c.toString();
      const m = /(\d{1,3})%/.exec(c.toString());
      if (m && onProgress) onProgress(Math.min(1, Number(m[1]) / 100));
    });

    child.on('error', (err) => reject(new Error(`Could not build the disc image: ${err.message}`)));

    child.on('close', (code) => {
      if (signal && signal.aborted) return reject(new AbortError('Building the disc image was stopped.'));
      if (code !== 0) return reject(new Error(describeIsoFailure(out)));
      if (onProgress) onProgress(1);
      resolve({ isoPath: outputIso, log: out });
    });
  });
}

function describeIsoFailure(output) {
  const text = String(output || '');
  if (/No space left|not enough space/i.test(text)) {
    return 'Ran out of disk space while building the disc image.';
  }
  if (/Permission denied/i.test(text)) {
    return 'Not allowed to write the disc image. Choose a different working folder in Setup.';
  }
  const line = text.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  return `Building the disc image failed. ${line || 'No reason given.'}`;
}

/**
 * The argument list for `hdiutil burn`.
 *
 *   -puppetstrings   progress as "PERCENT:n" lines, meant for a program to
 *                    read. Without it hdiutil prints a row of dots, and the bar
 *                    could only guess from the clock.
 *   -verifyburn /    whether to read the disc back afterwards. hdiutil verifies
 *   -noverifyburn    by default, so "no" has to be said outright.
 *
 *                    This used to pass `-noverify` for "no", which is not the
 *                    burn option. Either hdiutil rejects it, failing the burn
 *                    before it touches the drive, or it takes it as the
 *                    image-checksum option `attach` has, and reads the disc
 *                    back anyway. Either way, switching off "Check the disc
 *                    after writing it" in Setup did not do what it said.
 *   -forceclose      close the disc when it is written. hdiutil's default is
 *                    to leave it open for another session, and a DVD player
 *                    will not reliably play a disc that has not been closed.
 *   -nosynthesize    burn the image's blocks exactly as they are. By default
 *   -noaddpmap       hdiutil may build a new HFS+/ISO filesystem from an image
 *                    it does not think makes a valid disc, or add a partition
 *                    map in front of it. Either would undo the layout the image
 *                    was written to have — the files where the IFOs say.
 *   -speed           only for a retry; see burnIso. hdiutil's default is the
 *                    drive's maximum.
 *
 * The image goes last, after the options, which is the form hdiutil documents.
 * `-device` is deliberately absent: with none, hdiutil uses the attached writer,
 * and the IORegistry path it would need cannot be reconstructed safely from the
 * listing (it ends in the drive's own name, spaces and all).
 */
function buildBurnArgs({ isoPath, verify = true, speed = null }) {
  return [
    'burn',
    '-puppetstrings',
    verify ? '-verifyburn' : '-noverifyburn',
    '-forceclose',
    '-nosynthesize',
    '-noaddpmap',
    ...(speed ? ['-speed', String(speed)] : []),
    isoPath,
  ];
}

/**
 * Read hdiutil's burn output as it arrives: how far along it is, and which part
 * of the job it is on.
 *
 * Verification is a second pass over the whole disc that reports its own 0 to
 * 100, so with it on the bar gives writing a little over half and checking the
 * rest. A percentage that falls back sharply is taken as the start of the check
 * even if hdiutil never said so in words.
 */
function burnProgressReader({ verify }) {
  const WRITE_SHARE = verify ? 0.55 : 1;
  const state = { phase: 'write', percent: 0, writePercent: 0, seenPercent: false, message: null };

  const overall = () => {
    const p = Math.max(0, Math.min(100, state.percent)) / 100;
    return state.phase === 'verify' ? WRITE_SHARE + p * (1 - WRITE_SHARE) : p * WRITE_SHARE;
  };

  const line = (raw) => {
    const text = String(raw || '').trim();
    if (!text) return null;

    const pct = /^PERCENT:\s*(-?[\d.]+)/i.exec(text);
    if (pct) {
      const value = Number(pct[1]);
      if (!Number.isFinite(value) || value < 0) return { progress: false };
      if (verify && state.phase === 'write' && state.seenPercent && value + 20 < state.percent) {
        state.phase = 'verify';
        state.message = 'Checking the disc…';
      }
      state.percent = value;
      state.seenPercent = true;
      if (state.phase === 'write') state.writePercent = Math.max(state.writePercent, value);
      return { progress: true };
    }

    const words = text.replace(/^MESSAGE:\s*/i, '');
    // Only once writing is well along, so a check of the image before the burn
    // starts is not mistaken for the check of the disc after it.
    if (/verif/i.test(words) && verify && (state.writePercent >= 50 || !state.seenPercent)) {
      if (state.phase !== 'verify') state.percent = 0;
      state.phase = 'verify';
      state.message = 'Checking the disc…';
    } else if (/insert|waiting for/i.test(words)) {
      state.message = 'Waiting for a blank disc in the drive…';
    } else if (/clos|finish|lead-?out/i.test(words) && state.phase === 'write') {
      state.message = 'Finishing the disc…';
    } else if (/writ|burn|session|track|prepar/i.test(words) && state.phase === 'write') {
      state.message = null;
    }
    return { text: words };
  };

  return { line, overall, state };
}

/**
 * Burn an image to a real disc.
 *
 * `hdiutil burn` is the system path and uses the OS's own optical writer
 * support, including external USB burners.
 *
 * One retry, at 4x, for the failures that are about the drive and the disc not
 * getting on at full speed — the laser failing to calibrate, the drive stopping
 * responding — and only when nothing has been written yet, so the disc in the
 * drive is still blank. Those are the classic failures of an external USB burner
 * on a laptop's bus power and of budget discs, and a slower burn is the remedy
 * every burning program recommends for them. A burn that fails partway through
 * has already used the disc, and is not retried.
 */
async function burnIso({ isoPath, device, hdiutil, onProgress, signal, verify = true, log }) {
  if (isWindows) return windowsDisc.burnIso({ isoPath, device, onProgress, signal, log });

  if (!isMac) {
    throw new Error('Burning a disc needs Windows or macOS.');
  }
  if (!hdiutil) throw new Error('The system burning tool could not be found.');

  try {
    return await burnOnce({ isoPath, hdiutil, onProgress, signal, verify, log, speed: null });
  } catch (err) {
    if (!err || err.isAbort || !err.retrySlower) throw err;
    if (log) log('The drive could not write at full speed. Trying once more at 4x…');
    try {
      return await burnOnce({ isoPath, hdiutil, onProgress, signal, verify, log, speed: 4 });
    } catch (second) {
      if (second && second.isAbort) throw second;
      throw new Error(
        second.message === err.message
          ? `${err.message} A slower second attempt failed the same way.`
          : `${err.message} A slower second attempt failed too: ${second.message}`
      );
    }
  }
}

function burnOnce({ isoPath, hdiutil, onProgress, signal, verify, log, speed }) {
  const totalBytes = fs.statSync(isoPath).size;

  return new Promise((resolve, reject) => {
    const args = buildBurnArgs({ isoPath, verify, speed });
    if (log) log(`hdiutil ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);

    const child = spawn(hdiutil, args, { windowsHide: true });
    const reader = burnProgressReader({ verify });
    let words = [];
    let pending = '';
    let lastLogged = '';
    const started = Date.now();

    const onAbort = () => {
      try {
        // Ask hdiutil to stop cleanly rather than yanking the device.
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const report = () => {
      if (onProgress) onProgress(Math.min(0.99, reader.overall()), reader.state.message);
    };

    /*
      A clock, but only as a last resort.

      hdiutil is asked for real percentages. An estimate that ran from the start
      used to run ahead while the drive calibrated and then fall back when the
      first real figure arrived — a bar going up, dropping to nothing and going
      up again. So nothing is estimated for the first minute; only if hdiutil
      still has not reported anything by then (a macOS that never does) does the
      bar creep on a 4x estimate, and the page never lets it go backwards.
    */
    const assumedBytesPerSecond = 4 * 1.385 * 1000 * 1000;
    const timer = setInterval(() => {
      if (!onProgress || reader.state.seenPercent || totalBytes <= 0) return;
      const elapsed = (Date.now() - started) / 1000 - 60;
      if (elapsed <= 0) return;
      const estimate = Math.min(0.9, (elapsed * assumedBytesPerSecond) / totalBytes);
      onProgress(estimate * (verify ? 0.55 : 1), reader.state.message);
    }, 1000);

    const handle = (chunk) => {
      pending += chunk.toString();
      const lines = pending.split(/[\r\n]+/);
      pending = lines.pop() || '';
      let moved = false;
      for (const raw of lines) {
        const result = reader.line(raw);
        if (!result) continue;
        if (result.progress) moved = true;
        if (result.text) {
          words = [...words, result.text].slice(-40);
          if (log && result.text !== lastLogged && !/^\.+$/.test(result.text)) log(`  ${result.text}`);
          lastLogged = result.text;
          moved = true;
        }
      }
      if (moved) report();
    };

    child.stdout.on('data', handle);
    child.stderr.on('data', handle);

    child.on('error', (err) => {
      clearInterval(timer);
      reject(new Error(`Could not start burning: ${err.message}`));
    });

    child.on('close', (code) => {
      // The progress timer outlives the child otherwise, and keeps the process
      // alive after the burn has finished.
      clearInterval(timer);
      if (pending) handle('\n');
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) {
        return reject(new AbortError('Burning was stopped. The disc in the drive may be unusable.'));
      }
      if (code !== 0) {
        const text = words.join('\n');
        const err = new Error(describeBurnFailure(text));
        err.detail = text;
        err.retrySlower =
          speed === null &&
          reader.state.writePercent < 0.5 &&
          /calibrat|power level|failed to respond|not responding|underrun/i.test(text);
        return reject(err);
      }

      if (onProgress) onProgress(1, null);
      resolve({ log: words.join('\n') });
    });
  });
}

/**
 * Turn what hdiutil said into something she can act on.
 *
 * The phrases are DiscRecording's own, which is what hdiutil passes along: "The
 * device failed to calibrate the laser power level for this media", "Medium
 * write error", and so on. The original is kept at the end of anything not
 * recognised, so a new failure is still diagnosable from the message alone.
 */
/** Open the drive's tray: IMAPI on Windows, drutil on macOS. */
async function ejectDisc({ drutil, device } = {}) {
  if (isWindows) return windowsDisc.ejectDisc({ device });
  if (!drutil) throw new Error('The disc drive tool is not available.');
  try {
    await exec(drutil, ['eject']);
  } catch (err) {
    throw new Error(`Could not eject: ${err.message}`);
  }
  return true;
}

function describeBurnFailure(output) {
  const lines = String(output || '').split('\n').map((l) => l.trim()).filter(Boolean);
  /*
    Judged on the lines that report a problem, not on everything hdiutil said.

    hdiutil prints its "insert a disc" prompt on every burn, successful or not,
    and "Verifying" on every burn that checks. Matching the whole transcript
    called every failure a missing disc.
  */
  const complaints = lines.filter((l) => /fail|error|unable|cannot|can't|could not|not |denied|busy|unrecognized|usage/i.test(l));
  const text = (complaints.length ? complaints : lines.slice(-3)).join('\n');
  const said = (complaints[complaints.length - 1] || lines[lines.length - 1] || '').replace(/^hdiutil:\s*/i, '');
  const quote = said ? ` (macOS said: "${said}")` : '';

  if (/unrecognized option|unknown option|usage:/i.test(text)) {
    return `The system burner was given an option it does not accept, so nothing was written${quote}. The disc is still blank.`;
  }
  if (/no media|NoMedia|insert a (blank )?disc|media is not present/i.test(text)) {
    return 'The drive has no disc in it. Put in a blank DVD-R and try again.';
  }
  if (/not enough space|insufficient space|too (big|large)|does not fit|exceeds the capacity/i.test(text)) {
    return 'The disc is too small for this material. Use a blank DVD-R rather than a CD.';
  }
  if (/calibrat|power level/i.test(text)) {
    return (
      'The drive could not tune its laser to this disc. That is usually the disc brand and the drive ' +
        'not suiting each other: try a different brand of DVD-R (Verbatim suits almost every drive). ' +
        `If the burner is on a USB hub, plug it straight into the Mac${quote}.`
    );
  }
  if (/failed to respond|not responding|device (is )?not ready|timed? ?out|i\/o error|underrun/i.test(text)) {
    return (
      'The burner stopped responding partway. A USB burner needs a lot of power: plug it straight into ' +
        'the Mac rather than a hub, and if its cable has two USB plugs, connect both. Then try again ' +
        `with a fresh disc${quote}.`
    );
  }
  if (/medium write error|write error|writing failed/i.test(text)) {
    return (
      'The drive could not write to this disc. Try a fresh disc, ideally another brand, and plug the ' +
        `burner straight into the Mac${quote}.`
    );
  }
  if (/verif|compare|miscompare/i.test(text)) {
    return (
      'The disc was written, but reading it back did not match what was sent. It may still play — try ' +
        `it — but this disc is not trustworthy, and a different brand may do better${quote}.`
    );
  }
  if (/unwritable|not writable|read-only|write-protected|not blank|not appendable|already (been )?(written|closed)|closed/i.test(text)) {
    return 'This disc is not writable. It may already have been burned, or be a pressed disc.';
  }
  if (/busy|in use|exclusive access/i.test(text)) {
    return (
      'Another program is using the drive. Quit DVD Player and any other disc program, close any ' +
        `Finder window showing the blank disc, and try again${quote}.`
    );
  }
  if (/Permission denied|not permitted|Authorization/i.test(text)) {
    return (
      'macOS would not allow the burn. Open System Settings, Privacy & Security, ' +
        `and check nothing is blocking Burnhouse${quote}.`
    );
  }
  if (/device.*not found|No such device|no (burner|burning device|drive)/i.test(text)) {
    return 'The burner is no longer connected. Reconnect it and try again.';
  }
  return `Burning failed. ${said || 'No reason given.'}`;
}

/**
 * Copy a built disc somewhere permanent, for the case where she wants to keep
 * the disc contents and burn it later or on another machine.
 *
 * Into VIDEO_TS and AUDIO_TS folders inside the chosen one, because that is
 * what a DVD folder is — every burning program and player looks for VIDEO_TS
 * by name. This used to empty the IFOs and VOBs loose into the chosen folder,
 * which no burning program would recognise as a DVD, while the page said the
 * folder held a VIDEO_TS directory.
 *
 * And without blocking: it is gigabytes, and the app's window used to freeze for
 * as long as the copy took. On APFS the copy is a clone, which is instant.
 */
async function copyDiscFolder({ videoTsDir, destination, onProgress }) {
  const target = path.join(destination, 'VIDEO_TS');
  await fs.promises.mkdir(target, { recursive: true });
  await fs.promises.mkdir(path.join(destination, 'AUDIO_TS'), { recursive: true });
  const entries = (await fs.promises.readdir(videoTsDir, { withFileTypes: true })).filter((e) => e.isFile());
  const total = entries.length;

  let done = 0;
  for (const entry of entries) {
    await fs.promises.copyFile(
      path.join(videoTsDir, entry.name),
      path.join(target, entry.name),
      fs.constants.COPYFILE_FICLONE
    );
    done += 1;
    if (onProgress) onProgress(done / total);
  }

  return destination;
}

/**
 * How much free space a working folder has, so we can refuse a job that cannot
 * possibly finish rather than filling the disk. Returns null when it cannot be
 * determined.
 */
async function freeSpace(dir) {
  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(dir);
      return stats.bavail * stats.bsize;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** A note for platforms that genuinely cannot burn. */
async function platformDiscNote() {
  if (isMac || isWindows) return null;
  return 'Burning discs is supported on Windows and macOS.';
}

module.exports = {
  listDrives,
  buildIso,
  burnIso,
  ejectDisc,
  buildBurnArgs,
  burnProgressReader,
  IMAGE_REVISION,
  copyDiscFolder,
  freeSpace,
  platformDiscNote,
  summariseMedia,
  describeBurnFailure,
  describeIsoFailure,
  // Exported so the drive listing can be tested against real `drutil list`
  // output without a Mac and without a drive attached.
  parseDrutilList,
  parseDrutilXml,
  parseDrutilKeyValues,
  parseHdiutilBurnList,
  drutilColumnStarts,
  parseDrutilRow,
};
