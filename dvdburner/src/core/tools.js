'use strict';

/**
 * Locating the external command line tools Burnhouse depends on.
 *
 * There are three places a tool can come from, in priority order:
 *
 *   1. Whatever the user pointed at explicitly in Settings.
 *   2. The copy shipped inside the app bundle (Resources/bin on macOS).
 *   3. The system PATH, which is what makes development on any machine work.
 *
 * Development on Windows needs PATH fallback to be real, because the bundled
 * macOS binaries obviously are not present there.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

/** Extra directories worth checking before giving up on PATH. */
function fallbackDirs() {
  const dirs = [];
  if (isMac) {
    dirs.push(
      '/opt/homebrew/bin', // Apple silicon Homebrew
      '/usr/local/bin', // Intel Homebrew
      '/opt/local/bin', // MacPorts
      '/usr/bin',
      '/bin'
    );
  } else if (isWindows) {
    dirs.push(
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links'),
      path.join(process.env.LOCALAPPDATA || '', 'Burnhouse', 'bin'),
      'C:\\Program Files\\ffmpeg\\bin',
      'C:\\ffmpeg\\bin',
      'C:\\dvdauthor'
    );

    // WinGet installs live under a package-hash directory, so glob for them.
    try {
      const pkgRoot = path.join(
        process.env.LOCALAPPDATA || '',
        'Microsoft',
        'WinGet',
        'Packages'
      );
      for (const entry of fs.readdirSync(pkgRoot)) {
        if (/ffmpeg/i.test(entry)) {
          const bin = path.join(pkgRoot, entry);
          const sub = fs.readdirSync(bin).find((d) => /ffmpeg/i.test(d));
          if (sub) dirs.push(path.join(bin, sub, 'bin'));
          dirs.push(path.join(bin, 'bin'));
        }
      }
    } catch {
      /* WinGet not present, nothing to add. */
    }

    /*
      Programs that bundle dvdauthor — DVD Styler, GUI for dvdauthor — go LAST.

      dvdauthor has no Windows package of its own: it is a Unix program, and
      neither MSYS2 nor Cygwin ships it, so the only Windows builds are the ones
      inside other disc programs. Those programs also ship their own ffmpeg, and
      DVD Styler's is from 2019. Searching here first would quietly trade the
      current encoder for a seven-year-old one, so the folders are last: whatever
      else can supply ffmpeg does, and dvdauthor is found here because nothing
      else can supply it.
    */
    const programRoots = [
      process.env['ProgramFiles'] || 'C:\\Program Files',
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    ];
    const candidates = [];
    for (const root of programRoots) {
      for (const name of ['DVD Styler', 'DVDStyler', 'GUI for dvdauthor', 'GUI for DVDAuthor', 'GFD']) {
        candidates.push(path.join(root, name), path.join(root, name, 'bin'));
      }
      // Anything else whose folder name mentions dvd or author, which catches
      // the versions that name themselves differently.
      try {
        for (const entry of fs.readdirSync(root)) {
          if (!/dvd|author/i.test(entry)) continue;
          candidates.push(path.join(root, entry), path.join(root, entry, 'bin'));
        }
      } catch {
        /* the folder is unreadable; nothing to add */
      }
    }

    for (const dir of candidates) {
      try {
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) dirs.push(dir);
      } catch {
        /* a path that cannot be read simply is not a candidate */
      }
    }
  }
  return dirs.filter(Boolean);
}

/** Where bundled binaries live once the app is packaged. */
function bundledDir() {
  if (process.resourcesPath) {
    return path.join(process.resourcesPath, 'bin');
  }
  return path.join(__dirname, '..', '..', 'vendor', 'bin');
}

function executableNames(name) {
  return isWindows ? [`${name}.exe`, `${name}.cmd`, name] : [name];
}

/**
 * Find one tool. Returns an absolute path, or null when it is genuinely
 * missing. Never throws: a missing optional tool (dvdauthor) should degrade the
 * feature set, not break startup.
 */
function findTool(name, explicitPath) {
  const candidates = [];

  if (explicitPath && fs.existsSync(explicitPath)) {
    return explicitPath;
  }

  const bundleDir = bundledDir();
  for (const exe of executableNames(name)) {
    candidates.push(path.join(bundleDir, exe));
  }

  const dirs = fallbackDirs();

  for (const dir of dirs) {
    for (const exe of executableNames(name)) {
      candidates.push(path.join(dir, exe));
    }
  }

  // PATH itself.
  const pathParts = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathParts) {
    for (const exe of executableNames(name)) {
      candidates.push(path.join(dir, exe));
    }
  }

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }

  // On Windows fs.constants.X_OK is not meaningful, so retry existence-only.
  if (isWindows) {
    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep looking */
      }
    }
  }

  return null;
}

/**
 * macOS system burners. These ship with the OS, which is the point: no
 * third-party burning library to rot.
 */
function findMacBurnTools() {
  if (!isMac) return { hdiutil: null, drutil: null, diskutil: null };
  return {
    hdiutil: findTool('hdiutil') || '/usr/bin/hdiutil',
    drutil: findTool('drutil') || '/usr/bin/drutil',
    diskutil: findTool('diskutil') || '/usr/sbin/diskutil',
  };
}

/**
 * Full inventory. `ok` means the app can author a real DVD; without dvdauthor
 * we can still encode and we can still build a data disc.
 */
function detectTools(settings = {}) {
  const explicit = settings.toolPaths || {};

  const ffmpeg = findTool('ffmpeg', explicit.ffmpeg);
  const ffprobe = findTool('ffprobe', explicit.ffprobe);
  const dvdauthor = findTool('dvdauthor', explicit.dvdauthor);
  const spumux = findTool('spumux', explicit.spumux);
  const dvdauthorXml = Boolean(dvdauthor); // dvdauthor drives spumux internally
  const mkisofs =
    findTool('mkisofs', explicit.mkisofs) ||
    findTool('genisoimage', explicit.mkisofs) ||
    findTool('xorrisofs', explicit.mkisofs);

  const burn = findMacBurnTools();

  return {
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    ffmpeg,
    ffprobe,
    dvdauthor,
    spumux,
    mkisofs,
    hdiutil: burn.hdiutil,
    drutil: burn.drutil,
    diskutil: burn.diskutil,
    canEncode: Boolean(ffmpeg && ffprobe),
    canAuthor: Boolean(ffmpeg && ffprobe && dvdauthor),
    canBuildIso: Boolean(ffmpeg && (mkisofs || isMac || isWindows)),
    // Burning is done by the operating system on both platforms: hdiutil on
    // macOS, IMAPI2 on Windows. Either one is always present, so this is a
    // question of platform rather than of installed tools.
    canBurn: Boolean((isMac && burn.hdiutil) || isWindows),
    burnBackend: isMac ? 'hdiutil' : isWindows ? 'IMAPI2' : null,
  };
}

/** Probe a tool's version string, for the diagnostics panel. */
function toolVersion(toolPath, args = ['-version']) {
  return new Promise((resolve) => {
    if (!toolPath) return resolve(null);
    execFile(toolPath, args, { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      const text = String(stdout || '') + String(stderr || '');
      if (err && !text.trim()) return resolve(null);
      const first = text.split('\n').find((l) => l.trim()) || '';
      resolve(first.trim().slice(0, 120));
    });
  });
}

module.exports = {
  detectTools,
  findTool,
  toolVersion,
  bundledDir,
  fallbackDirs,
  isMac,
  isWindows,
};
