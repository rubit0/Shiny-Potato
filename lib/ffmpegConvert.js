const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const FFPROBE_TIMEOUT_MS = 20_000;

/**
 * Prefer bundled ffmpeg (macOS / Windows / Linux); fall back to PATH.
 * @returns {string}
 */
function getFfmpegPath() {
  try {
    const bundled = require('ffmpeg-static');
    if (typeof bundled === 'string' && bundled.length > 0 && fs.existsSync(bundled)) {
      return bundled;
    }
  } catch {
    // optional dependency missing or broken
  }
  return 'ffmpeg';
}

/**
 * Prefer bundled ffprobe; fall back to PATH.
 * @returns {string}
 */
function getFfprobePath() {
  try {
    const mod = require('ffprobe-static');
    const bundled = typeof mod === 'string' ? mod : mod?.path;
    if (typeof bundled === 'string' && bundled.length > 0 && fs.existsSync(bundled)) {
      return bundled;
    }
  } catch {
    // optional
  }
  return 'ffprobe';
}

/**
 * @param {string} ffprobePath
 * @param {string} inputPath
 * @returns {Promise<{ width: number, height: number } | null>}
 */
async function probeVideoDimensions(ffprobePath, inputPath) {
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-of',
        'json',
        inputPath,
      ],
      { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 }
    );
    const j = JSON.parse(stdout);
    const vs = j.streams?.[0];
    const w = vs?.width;
    const h = vs?.height;
    if (typeof w === 'number' && typeof h === 'number' && w >= 2 && h >= 2) {
      return { width: w, height: h };
    }
  } catch {
    // no video stream or probe failed
  }
  return null;
}

/**
 * Next standard short side among 720 / 1080 strictly above current min(w,h).
 * @param {number} minSide
 * @returns {720 | 1080 | null} null if already at or above 1080 on the short side
 */
function nextStandardTier(minSide) {
  for (const t of [720, 1080]) {
    if (minSide < t) {
      return t;
    }
  }
  return null;
}

/**
 * Denoise → (optional) scale to next 720p / 1080p tier on short side → mild sharpen.
 * Without known dimensions, applies cleanup filters only (no scale).
 * @param {boolean} upscale
 * @param {{ width: number, height: number } | null} dimensions
 * @returns {string | null} -vf chain or null when upscale is false
 */
function buildUpscaleFilterChain(upscale, dimensions) {
  if (!upscale) {
    return null;
  }

  const parts = ['hqdn3d=3:2:4:3'];
  const w = dimensions?.width;
  const h = dimensions?.height;
  if (typeof w === 'number' && typeof h === 'number' && w >= 2 && h >= 2) {
    const minS = Math.min(w, h);
    const targetTier = nextStandardTier(minS);
    if (targetTier != null) {
      if (w >= h) {
        parts.push(`scale=-2:${targetTier}:flags=lanczos`);
      } else {
        parts.push(`scale=${targetTier}:-2:flags=lanczos`);
      }
    }
  }
  parts.push('unsharp=5:5:0.6:3:3:0.0');
  return parts.join(',');
}

function probeDurationSeconds(ffprobePath, inputPath) {
  return new Promise((resolve) => {
    const proc = spawn(
      ffprobePath,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        inputPath,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    proc.stdout?.on('data', (d) => {
      out += d.toString();
    });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const v = parseFloat(out.trim(), 10);
      resolve(Number.isFinite(v) && v > 0 ? v : null);
    });
  });
}

/**
 * @param {string} line
 * @returns {{ timeSec: number, speed: string | null } | null}
 */
function parseFfmpegProgressLine(line) {
  if (!line.includes('time=') || line.includes('time=N/A')) {
    return null;
  }
  const tm = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!tm) {
    return null;
  }
  const timeSec =
    parseInt(tm[1], 10) * 3600 + parseInt(tm[2], 10) * 60 + parseFloat(tm[3]);
  const sp = line.match(/speed=\s*([\d.]+)x/);
  const speed = sp ? `${sp[1]}x` : null;
  return { timeSec, speed };
}

/**
 * @param {number} fileIndex 0-based
 * @param {number | null} filePercent 0–100 or null (unknown)
 * @param {number} totalFiles
 */
function computeOverallPercent(fileIndex, filePercent, totalFiles) {
  if (totalFiles <= 0) {
    return 100;
  }
  const fp = filePercent == null ? 0 : Math.min(100, Math.max(0, filePercent));
  return Math.min(100, ((fileIndex + fp / 100) / totalFiles) * 100);
}

/**
 * @param {string} outputDir
 * @param {string} baseName filename without extension
 * @returns {string} absolute path for a new .mp4 that does not yet exist
 */
function uniqueOutputPath(outputDir, baseName) {
  const safeBase = baseName.replace(/[/\\?%*:|"<>]/g, '_') || 'output';
  let n = 0;
  for (;;) {
    const name = n === 0 ? `${safeBase}.mp4` : `${safeBase}_${n}.mp4`;
    const full = path.join(outputDir, name);
    if (!fs.existsSync(full)) {
      return full;
    }
    n += 1;
  }
}

/**
 * @param {string} inputPath
 * @returns {string}
 */
function baseNameFromInput(inputPath) {
  return path.basename(inputPath, path.extname(inputPath));
}

/**
 * H.264 + AAC in MP4. Audio-only inputs (e.g. .amr) get a minimal black video via lavfi.
 * `-loglevel info` so stderr emits encoding progress (`time=`, `speed=`).
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {{ videoFilter?: string | null }} [options]
 * @returns {string[]}
 */
function buildFfmpegArgs(inputPath, outputPath, options = {}) {
  const { videoFilter = null } = options;
  const ext = path.extname(inputPath).toLowerCase();
  const audioOnly = ext === '.amr';

  if (audioOnly) {
    const args = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'info',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=1280x720:r=25',
      '-i',
      inputPath,
    ];
    if (videoFilter) {
      args.push('-vf', videoFilter);
    }
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '28',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-shortest',
      '-movflags',
      '+faststart',
      '-pix_fmt',
      'yuv420p',
      outputPath
    );
    return args;
  }

  const args = ['-y', '-hide_banner', '-loglevel', 'info', '-i', inputPath];
  if (videoFilter) {
    args.push('-vf', videoFilter);
  }
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '23',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    '-pix_fmt',
    'yuv420p',
    outputPath
  );
  return args;
}

const PROGRESS_THROTTLE_MS = 120;

/** @type {import('node:child_process').ChildProcess | null} */
let activeFfmpegProcess = null;
let abortRequested = false;

function resetAbortState() {
  abortRequested = false;
}

/**
 * Stops the current ffmpeg encode (if any). Used by Abort UI and app quit.
 */
function abortCurrentConversion() {
  abortRequested = true;
  if (activeFfmpegProcess) {
    try {
      activeFfmpegProcess.kill('SIGKILL');
    } catch {
      // ignore
    }
    activeFfmpegProcess = null;
  }
}

/**
 * @param {string} ffmpegPath
 * @param {string[]} args
 * @param {(info: { timeSec: number, speed: string | null }) => void} onProgressTick
 * @returns {Promise<void>}
 */
function runFfmpegWithProgress(ffmpegPath, args, onProgressTick) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    activeFfmpegProcess = proc;
    let stderrBuf = '';
    let fullStderr = '';
    let lastEmit = 0;

    proc.stderr?.on('data', (chunk) => {
      const s = chunk.toString();
      fullStderr += s;
      stderrBuf += s;
      let idx;
      while ((idx = stderrBuf.search(/[\r\n]/)) >= 0) {
        const raw = stderrBuf.slice(0, idx);
        stderrBuf = stderrBuf.slice(idx + 1);
        const line = raw.trim();
        if (!line) {
          continue;
        }
        const parsed = parseFfmpegProgressLine(line);
        if (!parsed) {
          continue;
        }
        const now = Date.now();
        if (now - lastEmit >= PROGRESS_THROTTLE_MS) {
          lastEmit = now;
          onProgressTick(parsed);
        }
      }
    });

    proc.on('error', (err) => {
      activeFfmpegProcess = null;
      reject(err);
    });
    proc.on('close', (code) => {
      activeFfmpegProcess = null;
      if (code === 0) {
        resolve();
        return;
      }
      if (abortRequested) {
        reject(new Error('ABORTED'));
        return;
      }
      const tail = fullStderr.trim().slice(-800) || `exit code ${code}`;
      reject(new Error(tail));
    });
  });
}

/**
 * @param {object} opts
 * @param {string} opts.ffmpegPath
 * @param {string} opts.ffprobePath
 * @param {string} opts.outputDir absolute or resolved folder
 * @param {string[]} opts.inputPaths
 * @param {(p: object) => void} [opts.onProgress]
 * @returns {Promise<{
 *   results: Array<{ inputPath: string, outputPath: string | null, ok: boolean, error?: string }>,
 *   aborted: boolean
 * }>}
 */
async function convertLegacyFilesToMp4(opts) {
  const { ffmpegPath, ffprobePath, outputDir, inputPaths, onProgress, upscale = false } = opts;
  resetAbortState();
  const resolvedOut = path.resolve(outputDir);
  await fsPromises.mkdir(resolvedOut, { recursive: true });

  const total = inputPaths.length;
  const results = [];

  const emit = (payload) => {
    if (onProgress) {
      onProgress(payload);
    }
  };

  for (let i = 0; i < inputPaths.length; i += 1) {
    if (abortRequested) {
      emit({ type: 'conversion-aborted', completedFiles: results.filter((r) => r.ok).length, totalFiles: total });
      return { results, aborted: true };
    }

    const inputPath = path.resolve(inputPaths[i]);
    const fileName = path.basename(inputPath);

    let durationSec = await probeDurationSeconds(ffprobePath, inputPath);

    emit({
      type: 'file-start',
      index: i,
      total,
      inputPath,
      fileName,
    });

    emit({
      type: 'overall',
      percent: computeOverallPercent(i, 0, total),
      completedFiles: i,
      totalFiles: total,
    });

    try {
      const st = await fsPromises.stat(inputPath).catch(() => null);
      if (!st?.isFile()) {
        throw new Error('Input file is not accessible');
      }

      const outPath = uniqueOutputPath(resolvedOut, baseNameFromInput(inputPath));

      const ext = path.extname(inputPath).toLowerCase();
      let dimensions =
        ext === '.amr'
          ? { width: 1280, height: 720 }
          : await probeVideoDimensions(ffprobePath, inputPath);
      const videoFilter = buildUpscaleFilterChain(upscale, dimensions);

      const args = buildFfmpegArgs(inputPath, outPath, { videoFilter });

      await runFfmpegWithProgress(ffmpegPath, args, ({ timeSec }) => {
        let percent = null;
        if (durationSec != null && durationSec > 0) {
          percent = Math.min(100, (timeSec / durationSec) * 100);
        }
        const overallPercent = computeOverallPercent(i, percent ?? 0, total);
        emit({
          type: 'encode-tick',
          index: i,
          total,
          inputPath,
          fileName,
          percent,
          overallPercent,
        });
      });

      emit({
        type: 'encode-tick',
        index: i,
        total,
        inputPath,
        fileName,
        percent: 100,
        overallPercent: computeOverallPercent(i, 100, total),
      });

      results.push({
        inputPath,
        outputPath: outPath,
        ok: true,
      });

      emit({
        type: 'file-done',
        index: i,
        total,
        inputPath,
        fileName,
        ok: true,
      });

      emit({
        type: 'overall',
        percent: computeOverallPercent(i + 1, 0, total),
        completedFiles: i + 1,
        totalFiles: total,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'ABORTED') {
        results.push({
          inputPath,
          outputPath: null,
          ok: false,
          error: 'Aborted',
        });
        emit({
          type: 'file-done',
          index: i,
          total,
          inputPath,
          fileName,
          ok: false,
          error: 'Aborted',
        });
        emit({ type: 'conversion-aborted', completedFiles: results.filter((r) => r.ok).length, totalFiles: total });
        return { results, aborted: true };
      }

      results.push({
        inputPath,
        outputPath: null,
        ok: false,
        error: message,
      });

      emit({
        type: 'file-done',
        index: i,
        total,
        inputPath,
        fileName,
        ok: false,
        error: message,
      });

      emit({
        type: 'overall',
        percent: computeOverallPercent(i + 1, 0, total),
        completedFiles: i + 1,
        totalFiles: total,
      });
    }
  }

  emit({
    type: 'overall',
    percent: 100,
    completedFiles: total,
    totalFiles: total,
  });

  return { results, aborted: false };
}

module.exports = {
  getFfmpegPath,
  getFfprobePath,
  convertLegacyFilesToMp4,
  abortCurrentConversion,
};
