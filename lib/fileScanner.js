const fs = require('fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { getFfprobePath } = require('./ffmpegConvert');

const execFileAsync = promisify(execFile);

/** Extensions treated as legacy sources for this app */
const LEGACY_VIDEO_EXTENSIONS = new Set([
  '.3gp',
  '.amr',
  '.mp4',
  '.m4v',
  '.avi',
  '.wmv',
  '.mov',
  '.flv',
  '.mpg',
  '.mpeg',
]);

/**
 * Codecs we treat as "modern" for typical MP4 playback today.
 * Anything else (when probed) is flagged as potentially legacy.
 */
const MODERN_MP4_VIDEO_CODECS = new Set([
  'h264',
  'hevc',
  'h265',
  'av1',
  'vp9',
  'vp8',
]);

const FFPROBE_TIMEOUT_MS = 20_000;

/**
 * @param {string | undefined} s
 * @returns {number | null}
 */
function parseFrameRateString(s) {
  if (s == null || typeof s !== 'string') {
    return null;
  }
  const parts = s.split('/');
  if (parts.length === 2) {
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if (den > 0 && Number.isFinite(num)) {
      return num / den;
    }
  }
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {string} rootResolved
 * @param {string} filePath
 * @returns {string} Path from root to the directory containing the file, using `/` separators
 */
function relativeSubfolderFromRoot(rootResolved, filePath) {
  const dir = path.dirname(filePath);
  const rel = path.relative(rootResolved, dir);
  if (!rel || rel === '.') {
    return '';
  }
  return rel.split(path.sep).join('/');
}

/**
 * @param {string} ffprobePath
 * @param {string} filePath
 * @returns {Promise<string | null>} Lowercase codec name, or null if no video / error
 */
async function probeMp4VideoCodec(ffprobePath, filePath) {
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        filePath,
      ],
      { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 }
    );
    const line = stdout.trim().split(/\r?\n/).find(Boolean);
    return line ? line.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * @param {string | null} codec
 * @returns {boolean | null} null if unknown / no video stream
 */
function mp4LegacyCodecLikely(codec) {
  if (codec === null || codec === '') {
    return null;
  }
  if (MODERN_MP4_VIDEO_CODECS.has(codec)) {
    return false;
  }
  return true;
}

/**
 * Duration (seconds) and first video stream dimensions when present.
 * @param {string} ffprobePath
 * @param {string} filePath
 * @returns {Promise<{ durationSec: number | null, width: number | null, height: number | null, frameRate: number | null }>}
 */
async function probeMediaInfo(ffprobePath, filePath) {
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-show_entries',
        'stream=width,height,codec_type,avg_frame_rate,r_frame_rate',
        '-of',
        'json',
        filePath,
      ],
      { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }
    );
    const j = JSON.parse(stdout);
    let durationSec = null;
    if (j.format?.duration != null) {
      const d = parseFloat(j.format.duration);
      durationSec = Number.isFinite(d) && d >= 0 ? d : null;
    }
    const streams = Array.isArray(j.streams) ? j.streams : [];
    const vs = streams.find((s) => s.codec_type === 'video');
    const width = vs?.width != null ? Number(vs.width) : null;
    const height = vs?.height != null ? Number(vs.height) : null;
    let frameRate =
      vs != null
        ? parseFrameRateString(vs.avg_frame_rate) ?? parseFrameRateString(vs.r_frame_rate)
        : null;
    if (
      frameRate != null &&
      (!Number.isFinite(frameRate) || frameRate <= 0 || frameRate >= 1000)
    ) {
      frameRate = null;
    }
    return {
      durationSec,
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null,
      frameRate,
    };
  } catch {
    return { durationSec: null, width: null, height: null, frameRate: null };
  }
}

/**
 * Recursively collect files under `rootResolved` matching legacy extensions.
 * @param {string} rootResolved
 * @returns {Promise<Array<{ fullPath: string, fileName: string, relativeSubfolder: string, extension: string }>>}
 */
async function collectMatchingFiles(rootResolved) {
  const out = [];

  async function walk(currentDir) {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      const full = path.join(currentDir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (!LEGACY_VIDEO_EXTENSIONS.has(ext)) {
          continue;
        }
        out.push({
          fullPath: full,
          fileName: ent.name,
          relativeSubfolder: relativeSubfolderFromRoot(rootResolved, full),
          extension: ext,
        });
      }
    }
  }

  await walk(rootResolved);
  out.sort((a, b) => a.fullPath.localeCompare(b.fullPath));
  return out;
}

/**
 * Recursively scan a folder for legacy video files (see {@link LEGACY_VIDEO_EXTENSIONS}).
 * MP4 entries include optional ffprobe data when `ffprobe` is on PATH.
 *
 * @param {string} rootPath
 * @returns {Promise<{
 *   rootPath: string,
 *   scannedAt: string,
 *   files: Array<{
 *     fullPath: string,
 *     fileName: string,
 *     relativeSubfolder: string,
 *     extension: string,
 *     mp4Codec: string | null,
 *     mp4LegacyCodecLikely: boolean | null
 *   }>
 * }>}
 * @param {(info: { index: number, total: number, fileName: string }) => void} [onProbeProgress]
 */
async function scanLegacyVideoFolder(rootPath, onProbeProgress) {
  const rootResolved = path.resolve(rootPath);
  const st = await fs.stat(rootResolved).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw new Error('Path is not an accessible directory');
  }

  const baseFiles = await collectMatchingFiles(rootResolved);

  const files = baseFiles.map((f) => {
    const row = {
      fullPath: f.fullPath,
      fileName: f.fileName,
      relativeSubfolder: f.relativeSubfolder,
      extension: f.extension,
      durationSec: null,
      width: null,
      height: null,
      frameRate: null,
      mp4Codec: null,
      mp4LegacyCodecLikely: null,
    };
    return row;
  });

  const ffprobePath = getFfprobePath();

  for (let i = 0; i < files.length; i += 1) {
    const row = files[i];
    if (typeof onProbeProgress === 'function') {
      onProbeProgress({ index: i, total: files.length, fileName: row.fileName });
    }
    const info = await probeMediaInfo(ffprobePath, row.fullPath);
    row.durationSec = info.durationSec;
    row.width = info.width;
    row.height = info.height;
    row.frameRate = info.frameRate;
    if (row.extension !== '.mp4' && row.extension !== '.m4v') {
      continue;
    }
    const codec = await probeMp4VideoCodec(ffprobePath, row.fullPath);
    row.mp4Codec = codec;
    row.mp4LegacyCodecLikely = mp4LegacyCodecLikely(codec);
  }

  return {
    rootPath: rootResolved,
    scannedAt: new Date().toISOString(),
    sourceKind: 'folder',
    files,
  };
}

/**
 * Longest common directory prefix for a set of absolute file paths.
 * @param {string[]} absoluteFilePaths
 * @returns {string}
 */
function commonAncestorDir(absoluteFilePaths) {
  if (absoluteFilePaths.length === 0) {
    throw new Error('No paths');
  }
  const dirs = absoluteFilePaths.map((p) => path.resolve(path.dirname(p)));
  if (dirs.length === 1) {
    return dirs[0];
  }
  const parts = dirs.map((d) => d.split(path.sep));
  const first = parts[0];
  let commonLen = 0;
  const minLen = Math.min(...parts.map((s) => s.length));
  for (let i = 0; i < minLen; i++) {
    const seg = first[i];
    if (!parts.every((p) => p[i] === seg)) {
      break;
    }
    commonLen = i + 1;
  }
  if (commonLen === 0) {
    return dirs[0];
  }
  return first.slice(0, commonLen).join(path.sep);
}

/**
 * Build scan results from explicit file paths (no directory walk).
 * Filters to legacy extensions, probes MP4 codecs.
 *
 * @param {string[]} inputPaths
 * @param {(info: { index: number, total: number, fileName: string }) => void} [onProbeProgress]
 */
async function scanLegacyVideoFiles(inputPaths, onProbeProgress) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    throw new Error('No file paths provided');
  }

  const existing = [];
  for (const p of inputPaths) {
    const abs = path.resolve(p);
    const st = await fs.stat(abs).catch(() => null);
    if (st?.isFile()) {
      existing.push(abs);
    }
  }

  if (existing.length === 0) {
    throw new Error('No accessible files in selection');
  }

  const matching = existing.filter((p) =>
    LEGACY_VIDEO_EXTENSIONS.has(path.extname(p).toLowerCase())
  );
  matching.sort((a, b) => a.localeCompare(b));

  const rootResolved =
    matching.length > 0 ? commonAncestorDir(matching) : commonAncestorDir(existing);

  const files = matching.map((fullPath) => ({
    fullPath,
    fileName: path.basename(fullPath),
    relativeSubfolder: relativeSubfolderFromRoot(rootResolved, fullPath),
    extension: path.extname(fullPath).toLowerCase(),
    durationSec: null,
    width: null,
    height: null,
    frameRate: null,
    mp4Codec: null,
    mp4LegacyCodecLikely: null,
  }));

  const ffprobePath = getFfprobePath();

  for (let i = 0; i < files.length; i += 1) {
    const row = files[i];
    if (typeof onProbeProgress === 'function') {
      onProbeProgress({ index: i, total: files.length, fileName: row.fileName });
    }
    const info = await probeMediaInfo(ffprobePath, row.fullPath);
    row.durationSec = info.durationSec;
    row.width = info.width;
    row.height = info.height;
    row.frameRate = info.frameRate;
    if (row.extension !== '.mp4' && row.extension !== '.m4v') {
      continue;
    }
    const codec = await probeMp4VideoCodec(ffprobePath, row.fullPath);
    row.mp4Codec = codec;
    row.mp4LegacyCodecLikely = mp4LegacyCodecLikely(codec);
  }

  return {
    rootPath: rootResolved,
    scannedAt: new Date().toISOString(),
    sourceKind: 'files',
    files,
  };
}

module.exports = {
  scanLegacyVideoFolder,
  scanLegacyVideoFiles,
  LEGACY_VIDEO_EXTENSIONS,
};
