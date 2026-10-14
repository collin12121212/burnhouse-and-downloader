'use strict';

/**
 * Burning discs on Windows.
 *
 * The same principle as the macOS path: drive the operating system's own
 * optical burning support rather than linking a third-party library. Windows has
 * shipped IMAPI2 (the Image Mastering API) since Vista, reachable through COM,
 * and it handles external USB writers exactly like internal ones.
 *
 * All of it is done in PowerShell, which is the only scripting host guaranteed
 * to be present on Windows and which can talk to COM without compiling anything.
 * The scripts are written to a temporary file and run with `-File`, because
 * passing a script through `-Command` means fighting command-line quoting for
 * every path that contains a space.
 *
 * So the whole feature adds a .ps1 and nothing else: no bundled binaries, no
 * native module, nothing to rot against a future Windows release.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { AbortError } = require('./encode');

const POWERSHELL = 'powershell.exe';

/** Run a PowerShell script that was written to a temporary file. */
function runScript(script, { onOutput, signal, timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burnhouse-ps-'));
    const scriptPath = path.join(dir, 'job.ps1');
    // UTF-8 with a BOM, so Windows PowerShell reads non-ASCII paths correctly.
    fs.writeFileSync(scriptPath, `\uFEFF${script}`, 'utf8');

    const child = spawn(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true }
    );

    let out = '';
    let err = '';

    const onAbort = () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      onAbort();
      reject(new Error('The disc tool stopped responding and was closed.'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      out = (out + text).slice(-200000);
      if (onOutput) onOutput(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      err = (err + text).slice(-20000);
      if (onOutput) onOutput(text);
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`PowerShell could not be started: ${e.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* not important */
      }
      if (signal && signal.aborted) {
        return reject(new AbortError('The disc job was stopped.'));
      }
      if (code !== 0) {
        // The script's own trap names the failure. Without it, PowerShell's
        // last line of output is its error record's furniture — measured: "+
        // FullyQualifiedErrorId : System.Runtime.InteropServices.COMException"
        // — which says nothing about what went wrong.
        const reported = /BURNHOUSE_ERROR:\s*(.+)/.exec(`${err}\n${out}`);
        const line = reported
          ? reported[1].trim()
          : `${err}\n${out}`.split('\n').map((l) => l.trim()).filter(Boolean).pop();
        return reject(new Error(line || 'The disc tool failed.'));
      }
      resolve({ stdout: out, stderr: err });
    });
  });
}

/** The last JSON value a script printed, or null. */
function lastJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  // Any log lines come first; the result is the final line.
  const line = trimmed.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Script shared by everything here: find a recorder.
 *
 * A recorder is identified by the disc master's device ID, which is stable
 * whether or not a disc is in the drive — a drive letter is not, because a
 * burner with no media has no volume at all.
 */
const PRELUDE = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
trap {
  [Console]::Error.WriteLine('BURNHOUSE_ERROR: ' + $_.Exception.Message)
  exit 1
}

function Get-Recorders {
  $list = @()
  try {
    $master = New-Object -ComObject IMAPI2.MsftDiscMaster2
  } catch {
    return $list
  }
  foreach ($id in $master) {
    try {
      $recorder = New-Object -ComObject IMAPI2.MsftDiscRecorder2
      $recorder.InitializeDiscRecorder($id)
      $volumes = @()
      try { $volumes = @($recorder.VolumePathNames) } catch { }
      $list += [pscustomobject]@{ Id = $id; Recorder = $recorder; Volumes = $volumes }
    } catch { }
  }
  return $list
}

function Get-RecorderById($wanted) {
  foreach ($entry in (Get-Recorders)) {
    if ($entry.Id -eq $wanted) { return $entry }
  }
  return $null
}

# The media state flags, from IMAPI_FORMAT2_DATA_MEDIA_STATE.
function Get-MediaState($recorder) {
  $nothing = [pscustomobject]@{
    Present = $false; Blank = $false; Appendable = $false; Final = $false
    Unsupported = $false; Rewritable = $false
    FreeSectors = 0; TotalSectors = 0; State = -1; Text = 'No disc'; PhysicalType = 0
  }

  try {
    $format = New-Object -ComObject IMAPI2.MsftDiscFormat2Data
    $format.Recorder = $recorder
    if (-not $format.IsCurrentMediaSupported($recorder)) { return $nothing }
    $state = [int]$format.CurrentMediaStatus
  } catch {
    return $nothing
  }

  $blankFlag = (($state -band 0x1) -ne 0)
  $appendable = (($state -band 0x2) -ne 0)
  $final = (($state -band 0x4) -ne 0)
  $unsupported = (($state -band 0x10) -ne 0)
  $overwriteOnly = (($state -band 0x20) -ne 0)

  # Free space is the honest measure of whether a disc is empty, and the flags
  # alone are not reliable.
  #
  # A brand new DVD-R in an hp DVDRW DU8A6SH is reported as
  # APPENDABLE | FINAL_SESSION with no BLANK bit at all - which reads as "already
  # written" if you trust the flags, and rejected perfectly good discs. The same
  # disc reports 2,297,888 free sectors out of 2,297,888, and a next writable
  # address of zero: nothing has ever been written to it.
  #
  # So a disc that has as much free space as it has in total is treated as blank
  # whatever the drive calls it.
  $free = 0
  $total = 0
  try { $free = [int64]$format.FreeSectorsOnMedia } catch { }
  try { $total = [int64]$format.TotalSectorsOnMedia } catch { }

  $physical = 0
  try { $physical = [int]$format.CurrentPhysicalMediaType } catch { }

  $blank = $blankFlag -or ($total -gt 0 -and $free -ge $total)

  $text = if ($unsupported) { 'Unsupported disc' }
    elseif ($blank) { 'Blank' }
    elseif ($appendable) { 'Partly used' }
    elseif ($overwriteOnly) { 'Rewritable' }
    elseif ($final) { 'Already written' }
    else { 'Present' }

  return [pscustomobject]@{
    Present = $true
    Blank = $blank
    Appendable = $appendable
    Final = $final
    Unsupported = $unsupported
    Rewritable = $overwriteOnly
    FreeSectors = $free
    TotalSectors = $total
    State = $state
    Text = $text
    PhysicalType = $physical
  }
}
`;

/** List the optical writers attached to this computer. */
async function listDrives() {
  const script = `${PRELUDE}
$out = @()
foreach ($entry in (Get-Recorders)) {
  $media = Get-MediaState $entry.Recorder
  $volumes = @($entry.Volumes)
  # What Windows itself can read from the disc. IMAPI will not describe a disc
  # that has been closed - which is every disc after a successful burn - but the
  # filesystem on it is there, and says how much is on it.
  $drive = $null
  if ($volumes.Count -gt 0) {
    try {
      $di = New-Object System.IO.DriveInfo($volumes[0])
      if ($di.IsReady) { $drive = $di }
    } catch { }
  }
  $label = ("$($entry.Recorder.VendorId) $($entry.Recorder.ProductId)").Trim()
  $out += [pscustomobject]@{
    id = $entry.Id
    label = $label
    vendor = $entry.Recorder.VendorId
    product = $entry.Recorder.ProductId
    revision = $entry.Recorder.ProductRevision
    volumePath = $(if ($volumes.Count -gt 0) { $volumes[0] } else { $null })
    mediaPresent = ($media.Present -or ($drive -ne $null))
    mediaPhysicalType = $media.PhysicalType
    mediaReadable = ($drive -ne $null)
    mediaUsedBytes = $(if ($drive -ne $null) { [int64]$drive.TotalSize } else { 0 })
    mediaText = $media.Text
    mediaBlank = $media.Blank
    mediaRewritable = $media.Rewritable
    mediaFreeSectors = $media.FreeSectors
    mediaTotalSectors = $media.TotalSectors
  }
}
@($out) | ConvertTo-Json -Depth 4 -Compress
`;

  const { stdout } = await runScript(script, { timeoutMs: 60000 });
  const parsed = lastJson(stdout);
  const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];

  const drives = rows.map((row) => ({
    id: row.id,
    device: row.id,
    vendor: row.vendor || '',
    product: row.product || '',
    rev: row.revision || '',
    bus: 'USB',
    supportLevel: row.mediaText || '',
    writeCapable: true,
    volumePath: row.volumePath || null,
    label: [row.label, row.volumePath].filter(Boolean).join('  ').trim() || row.id,
    media: windowsMedia(row, {
      present: Boolean(row.mediaPresent),
      type: row.mediaText || null,
      erasable: Boolean(row.mediaRewritable),
      blank: Boolean(row.mediaBlank),
      /*
        Free space as a figure, not just a word.

        The drive list used to show whatever the media-state flags happened to
        say. This drive calls a brand new DVD-R "Partly used", which is alarming
        and wrong — the disc had 2,297,888 free sectors out of 2,297,888. A
        number cannot be misread that way, so the free space is reported in the
        same terms a blank disc is sold in.
      */
      freeSpace: formatDiscSpace(row.mediaFreeSectors, row.mediaTotalSectors),
      raw: row.mediaText || '',
    }),
  }));

  return {
    supported: true,
    drives,
    note: drives.length
      ? null
      : 'No disc writer was found. Plug the burner in and press Refresh.',
  };
}

/**
 * Two small pieces of C#, compiled once at run time with `Add-Type`.
 *
 *   BurnhouseStreamCopy.ToFile  copies a COM stream to a file. PowerShell
 *       cannot cast the object IMAPI hands back to `IStream` — the interop
 *       wrapper does not expose the interface to its type system — and C# can.
 *
 *   BurnhouseFileStream.Open    opens a file as a COM stream, which is what
 *       IMAPI writes from. This replaced ADODB.Stream, which loads the whole
 *       file before handing it over: four gigabytes read up front, held in
 *       memory, on the machine that is about to need its memory for the burn.
 *
 *   BurnhouseProgressStream     passes IMAPI's reads straight through to that
 *       stream and prints how far through the image it is. IMAPI's `Write`
 *       blocks until the disc is finished and reports progress only through
 *       COM events PowerShell cannot sink while it is blocked, so this is how
 *       the bar learns where the burn really is.
 *
 * Compiling takes about a second, which is nothing next to writing a DVD.
 */
const STREAM_HELPERS = `
if (-not ('BurnhouseProgressStream' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class BurnhouseStreamCopy
{
    public static long ToFile(object comStream, string path)
    {
        IStream stream = (IStream)comStream;
        long total = 0;
        using (FileStream file = File.Create(path))
        {
            byte[] buffer = new byte[1 << 20];
            IntPtr readPtr = Marshal.AllocCoTaskMem(4);
            try
            {
                while (true)
                {
                    stream.Read(buffer, buffer.Length, readPtr);
                    int read = Marshal.ReadInt32(readPtr);
                    if (read <= 0) { break; }
                    file.Write(buffer, 0, read);
                    total += read;
                }
            }
            finally
            {
                Marshal.FreeCoTaskMem(readPtr);
            }
        }
        return total;
    }
}

public static class BurnhouseFileStream
{
    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateStreamOnFileEx(
        string file, uint mode, uint attributes, bool create, IStream template, out IStream stream);

    public static object Open(string path)
    {
        IStream stream;
        // STGM_READ | STGM_SHARE_DENY_WRITE
        SHCreateStreamOnFileEx(path, 0x00000020, 0, false, null, out stream);
        return stream;
    }
}

[ComVisible(true)]
[ClassInterface(ClassInterfaceType.None)]
public class BurnhouseProgressStream : IStream
{
    private readonly IStream inner;
    private readonly long total;
    private long position;
    private int reported = -1;

    public BurnhouseProgressStream(object stream, long total)
    {
        this.inner = (IStream)stream;
        this.total = total;
    }

    public long Position { get { return Interlocked.Read(ref position); } }

    private void Report()
    {
        if (total <= 0) { return; }
        int permille = (int)Math.Min(1000, Position * 1000 / total);
        if (permille == reported) { return; }
        reported = permille;
        Console.Out.WriteLine("BURNHOUSE_PROGRESS " + permille);
        Console.Out.Flush();
    }

    public void Read(byte[] pv, int cb, IntPtr pcbRead)
    {
        IntPtr counter = pcbRead;
        bool own = counter == IntPtr.Zero;
        if (own) { counter = Marshal.AllocCoTaskMem(4); }
        try
        {
            inner.Read(pv, cb, counter);
            Interlocked.Add(ref position, Marshal.ReadInt32(counter));
        }
        finally
        {
            if (own) { Marshal.FreeCoTaskMem(counter); }
        }
        Report();
    }

    public void Seek(long dlibMove, int dwOrigin, IntPtr plibNewPosition)
    {
        IntPtr target = plibNewPosition;
        bool own = target == IntPtr.Zero;
        if (own) { target = Marshal.AllocCoTaskMem(8); }
        try
        {
            inner.Seek(dlibMove, dwOrigin, target);
            Interlocked.Exchange(ref position, Marshal.ReadInt64(target));
        }
        finally
        {
            if (own) { Marshal.FreeCoTaskMem(target); }
        }
    }

    public void Stat(out System.Runtime.InteropServices.ComTypes.STATSTG pstatstg, int grfStatFlag) { inner.Stat(out pstatstg, grfStatFlag); }
    public void Clone(out IStream ppstm) { inner.Clone(out ppstm); }
    public void Write(byte[] pv, int cb, IntPtr pcbWritten) { inner.Write(pv, cb, pcbWritten); }
    public void SetSize(long libNewSize) { inner.SetSize(libNewSize); }
    public void CopyTo(IStream pstm, long cb, IntPtr pcbRead, IntPtr pcbWritten) { inner.CopyTo(pstm, cb, pcbRead, pcbWritten); }
    public void Commit(int grfCommitFlags) { inner.Commit(grfCommitFlags); }
    public void Revert() { inner.Revert(); }
    public void LockRegion(long libOffset, long cb, int dwLockType) { inner.LockRegion(libOffset, cb, dwLockType); }
    public void UnlockRegion(long libOffset, long cb, int dwLockType) { inner.UnlockRegion(libOffset, cb, dwLockType); }
}
'@
}
`;

/** Build a DVD-Video image with IMAPI.
 *
 * The fallback only: dvd_image.js writes the image now, because IMAPI lays a
 * VIDEO_TS folder out alphabetically and a set-top player then looks for the
 * title set in the wrong place. This remains for anything that writer cannot
 * handle, since a less exact disc is better than none.
 *
 * UDF is not optional: DVD-Video is a UDF filesystem, and an image with only
 * ISO9660 is exactly the kind of disc that plays on a computer and refuses to
 * play in a set-top player. `FileSystemsToCreate = 7` is ISO9660 + Joliet + UDF.
 *
 * `FreeMediaBlocks = 0` lifts IMAPI's size limit, which otherwise defaults to a
 * 650 MB CD: measured, adding a 900 MB VOB failed with "would result in a result
 * image having a size larger than the current configured limit". Every real DVD
 * is larger than a CD, so without it this could never have built one.
 *
 * `sourceDir` is the folder that CONTAINS VIDEO_TS, which is what the other
 * paths are given. Only the two folders a DVD-Video disc may have are added, so
 * the authoring folder's other contents — dvdauthor.xml, the menu stills,
 * scratch files — stay off the disc.
 */
async function buildIso({ sourceDir, outputIso, volumeLabel, signal }) {
  fs.mkdirSync(path.dirname(outputIso), { recursive: true });
  fs.rmSync(outputIso, { force: true });

  const videoTs = path.join(sourceDir, 'VIDEO_TS');
  const audioTs = path.join(sourceDir, 'AUDIO_TS');

  const script = `${PRELUDE}
${STREAM_HELPERS}
$videoTs = ${psQuote(videoTs)}
$audioTs = ${psQuote(audioTs)}
$output = ${psQuote(outputIso)}
$label = ${psQuote(String(volumeLabel || 'MY_DVD').slice(0, 32))}

if (-not (Test-Path -LiteralPath $videoTs)) { throw "The VIDEO_TS folder is missing: $videoTs" }

$image = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
$image.FileSystemsToCreate = 7
$image.UDFRevision = 0x102
$image.FreeMediaBlocks = 0
$image.VolumeName = $label

# The base directory is included, so VIDEO_TS lands at the root of the disc
# rather than its contents being spilled loose among the root files.
$image.Root.AddTree($videoTs, $true)
if (Test-Path -LiteralPath $audioTs) { $image.Root.AddTree($audioTs, $true) }

$result = $image.CreateResultImage()
$written = [BurnhouseStreamCopy]::ToFile($result.ImageStream, $output)

[pscustomobject]@{ isoPath = $output; bytes = $written } | ConvertTo-Json -Compress
`;

  const { stdout } = await runScript(script, { signal, timeoutMs: 30 * 60 * 1000 });
  const result = lastJson(stdout);
  if (!result || !fs.existsSync(outputIso)) {
    throw new Error('The disc image was not produced.');
  }
  return { isoPath: outputIso, bytes: result.bytes, log: stdout };
}

/**
 * Write an image to a real disc.
 *
 * The image file is handed to IMAPI as a stream it reads as it writes, through
 * BurnhouseProgressStream, whose position is the progress bar. The wrapper is a
 * .NET object passed to COM, and if IMAPI ever refuses it the same file goes in
 * directly, unwrapped, before anything has been written — the bar then falls
 * back to an estimate, and the burn is no worse than it was.
 */
async function burnIso({ isoPath, device, onProgress, signal, log }) {
  if (!fs.existsSync(isoPath)) throw new Error('The disc image is missing.');

  const totalBytes = fs.statSync(isoPath).size;
  const script = `${PRELUDE}
${STREAM_HELPERS}
$iso = ${psQuote(isoPath)}
$wanted = ${psQuote(device || '')}

$entry = $null
if ($wanted -ne '') { $entry = Get-RecorderById $wanted }
if ($entry -eq $null) {
  $all = @(Get-Recorders)
  if ($all.Count -eq 0) { throw 'No disc writer was found. Plug the burner in and try again.' }
  $entry = $all[0]
}

$media = Get-MediaState $entry.Recorder
if (-not $media.Present) {
  throw 'The drive has no disc in it. Put in a blank DVD-R and try again.'
}
if ($media.Unsupported) {
  throw 'This disc cannot be written by this drive. Use a blank DVD-R.'
}

# Refuse a disc that is genuinely used up, and say which of the two it is: too
# small, or already written to. Space is what decides, because the flags do not
# mean what they look like on every drive.
$length = (Get-Item -LiteralPath $iso).Length
$needSectors = [int64][math]::Ceiling($length / 2048)
# A rewritable disc is left to IMAPI, which overwrites it as a whole.
if (-not $media.Rewritable -and $media.FreeSectors -gt 0 -and $media.FreeSectors -lt $needSectors) {
  if ($media.TotalSectors -gt 0 -and $media.TotalSectors -lt 400000) {
    throw 'That looks like a CD, not a DVD. This disc needs a blank DVD-R.'
  }
  if ($media.Blank) {
    throw 'The disc is too small for this material. A single-layer DVD holds 4.7 GB.'
  }
  throw 'This disc already has something on it. Use a blank DVD-R.'
}

$format = New-Object -ComObject IMAPI2.MsftDiscFormat2Data
$format.Recorder = $entry.Recorder
$format.ClientName = 'Burnhouse'
try { $format.ForceMediaToBeClosed = $true } catch { }

$file = [BurnhouseFileStream]::Open($iso)
$progress = New-Object BurnhouseProgressStream($file, $length)
try {
  $format.Write($progress)
} catch {
  # Refused before a single byte was read: hand IMAPI the file itself.
  if ($progress.Position -ne 0) { throw }
  [Console]::Out.WriteLine('BURNHOUSE_NOPROGRESS')
  $format.Write($file)
}

[pscustomobject]@{ ok = $true; recorder = $entry.Recorder.ProductId } | ConvertTo-Json -Compress
`;

  /*
    No estimate.

    A clock-driven bar used to run ahead while the drive calibrated and spun up,
    and then fell back to zero when the first real figure arrived. The bar now
    waits, honestly, until IMAPI reports where it really is.
  */
  // Only if IMAPI refuses the progress stream (see the script): an estimate
  // at 4x is then all there is, and the page never lets it go backwards.
  let fallback = null;
  let pending = '';
  const onOutput = (text) => {
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      const m = /BURNHOUSE_PROGRESS (\d+)/.exec(line);
      if (m && onProgress) {
        const permille = Number(m[1]);
        // IMAPI has read everything once the stream is exhausted, but the drive
        // still has to close the disc, which takes a minute or so.
        onProgress(Math.min(0.97, permille / 1000), permille >= 1000 ? 'Finishing the disc…' : null);
      } else if (/BURNHOUSE_NOPROGRESS/.test(line)) {
        if (log) log('  (the drive is being written without progress reports; the bar is an estimate)');
        if (onProgress && !fallback) {
          const started = Date.now();
          fallback = setInterval(() => {
            const elapsed = (Date.now() - started) / 1000;
            onProgress(Math.min(0.9, (elapsed * 4 * 1.385 * 1000 * 1000) / totalBytes), null);
          }, 1000);
        }
      }
    }
  };

  try {
    const { stdout } = await runScript(script, {
      signal,
      timeoutMs: 60 * 60 * 1000,
      onOutput,
    });
    const result = lastJson(stdout);
    if (!result || !result.ok) throw new Error('The burn did not report success.');
    if (onProgress) onProgress(1);
    return { log: stdout };
  } catch (err) {
    if (err && err.isAbort) throw err;
    if (log) log(`  ${err.message}`);
    throw new Error(describeBurnFailure(err.message));
  } finally {
    if (fallback) clearInterval(fallback);
  }
}

/**
 * What the page is told about the disc in a Windows drive.
 *
 * The type is the disc's own ("DVD-R") rather than IMAPI's state ("Already
 * written"), which is what the drive list shows beside the size.
 *
 * Whether the disc is used is decided here, because the page decides whether
 * Burn is allowed from it: a disc that is not blank and cannot be erased has
 * been written, whatever the drive chooses to call it. That includes the disc
 * that has just been burned and is still in the tray — IMAPI will not describe a
 * closed disc at all, so for those the filesystem Windows mounted from it is what
 * says there is something on it, and how much.
 */
const PHYSICAL_TYPES = {
  1: 'CD-ROM', 2: 'CD-R', 3: 'CD-RW', 4: 'DVD-ROM', 5: 'DVD-RAM', 6: 'DVD+R', 7: 'DVD+RW',
  8: 'DVD+R DL', 9: 'DVD-R', 10: 'DVD-RW', 11: 'DVD-R DL', 13: 'DVD+RW DL',
};

function nominalCapacity(type) {
  if (/DL/.test(type)) return '8.5 GB';
  if (/^DVD/.test(type)) return '4.7 GB';
  if (/^CD/.test(type)) return '700 MB';
  return null;
}

function windowsMedia(row, media) {
  const typeName = PHYSICAL_TYPES[Number(row.mediaPhysicalType)] || null;
  const readable = Boolean(row.mediaReadable);
  const imapiSaysPresent = Boolean(row.mediaPresent) && row.mediaText !== 'No disc';
  const usedBytes = Number(row.mediaUsedBytes) || 0;

  const written = media.present && !media.blank && !media.erasable;
  // IMAPI sees nothing, yet Windows has a filesystem from the disc: closed.
  const closedByBurn = readable && !imapiSaysPresent;
  const used = written || closedByBurn;

  const size = (bytes) =>
    bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;

  return {
    ...media,
    present: media.present || readable,
    type: typeName || (closedByBurn ? 'Disc' : media.type),
    alreadyWritten: used,
    usedSpace: used && usedBytes > 0 ? `${size(usedBytes)} used` : null,
    capacity: typeName ? nominalCapacity(typeName) : null,
  };
}

/**
 * Open the tray of a writer. With no device named, the first one is used —
 * the same drive a burn would pick.
 */
async function ejectDisc({ device } = {}) {
  const script = `${PRELUDE}
$wanted = ${psQuote(device || '')}
$entry = $null
if ($wanted -ne '') { $entry = Get-RecorderById $wanted }
if ($entry -eq $null) {
  $all = @(Get-Recorders)
  if ($all.Count -eq 0) { throw 'No disc writer was found. Plug the burner in and try again.' }
  $entry = $all[0]
}
$entry.Recorder.EjectMedia()
`;
  await runScript(script, { timeoutMs: 30000 });
  return true;
}

/** A single-quoted PowerShell string, with quotes escaped the PowerShell way. */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * How much room is on the disc, in the terms a blank disc is sold in.
 *
 * A sector is 2048 bytes, and a "4.7 GB" DVD-R is 2,297,888 of them. Showing the
 * figure means an empty disc reads as empty even when the drive's own summary of
 * it does not.
 */
function formatDiscSpace(freeSectors, totalSectors) {
  const free = Number(freeSectors) || 0;
  const total = Number(totalSectors) || 0;
  if (!total) return null;

  const gb = (sectors) => (sectors * 2048) / 1e9;
  if (free <= 0) return `full (${gb(total).toFixed(1)} GB disc)`;
  if (free >= total) return `blank, ${gb(total).toFixed(1)} GB free`;
  return `${gb(free).toFixed(1)} GB free of ${gb(total).toFixed(1)} GB`;
}

/** Turn IMAPI's messages into something worth showing somebody. */
function describeBurnFailure(message) {
  const text = String(message || '');
  // Before "no disc", which it also matches.
  if (/no disc writer/i.test(text)) {
    return 'No disc writer was found. Plug the burner in and try again.';
  }
  if (/no disc|no media|NoMedia/i.test(text)) {
    return 'The drive has no disc in it. Put in a blank DVD-R and try again.';
  }
  if (/looks like a CD/i.test(text)) {
    return 'That looks like a CD, not a DVD. This disc needs a blank DVD-R.';
  }
  if (/already has something|not blank|not writable|read-only/i.test(text)) {
    return 'This disc is not writable. It may already have been burned, or be a pressed disc.';
  }
  if (/too (big|large|small)|does not fit|not enough space/i.test(text)) {
    return 'The disc is too small for this material. A single-layer DVD-R holds 4.7 GB.';
  }
  if (/access is denied|denied|permission/i.test(text)) {
    return 'Windows would not allow the burn. Close any other disc program and try again.';
  }
  if (/cannot be written by this drive|unsupported/i.test(text)) {
    return 'This drive cannot write this kind of disc. Use a blank DVD-R.';
  }
  return `Burning failed. ${text || 'No reason given.'}`;
}

/** Whether this computer can burn, and what is missing if not. */
function platformNote() {
  return null;
}

module.exports = {
  listDrives,
  buildIso,
  burnIso,
  ejectDisc,
  windowsMedia,
  describeBurnFailure,
  platformNote,
  // For the tests, which run the stream helpers without a burner: IMAPI's
  // filesystem builder takes a stream through the same COM call as a burn.
  runScript,
  PRELUDE,
  STREAM_HELPERS,
  psQuote,
};
