const scanResultsEl = document.getElementById('scan-results');
const emptyBrandEl = document.getElementById('empty-brand');
const folderBtn = document.getElementById('folder-btn');
const filesBtn = document.getElementById('files-btn');
const convertBtn = document.getElementById('convert-btn');
const upscaleToggle = document.getElementById('upscale-toggle');
const headerProgressWrap = document.getElementById('header-progress-wrap');
const overallProgressBar = document.getElementById('overall-progress-bar');
const overallProgressText = document.getElementById('overall-progress-text');
const overallProgressFiles = document.getElementById('overall-progress-files');

const CONVERT_LABEL_DEFAULT = '🎞️ Convert';
const CONVERT_ARIA_LABEL = 'Convert selected videos to MP4';

function syncEmptyBrand() {
  if (!emptyBrandEl) {
    return;
  }
  emptyBrandEl.hidden = scanResultsEl.childElementCount > 0;
}

function clearScanNotices() {
  scanResultsEl.querySelectorAll('.scan-results__notice').forEach((el) => {
    el.remove();
  });
}

/**
 * @param {string} message
 */
function showScanNotice(message) {
  clearScanNotices();
  const p = document.createElement('p');
  p.className = 'scan-results__notice';
  p.textContent = message;
  scanResultsEl.prepend(p);
  syncEmptyBrand();
}

function buildIndeterminateScanBar() {
  const scanningTrack = document.createElement('div');
  scanningTrack.className = 'scan-results__scan-progress';
  scanningTrack.setAttribute('role', 'progressbar');
  scanningTrack.setAttribute('aria-label', 'Scan in progress');
  scanningTrack.setAttribute('aria-busy', 'true');
  const scanningInner = document.createElement('div');
  scanningInner.className = 'scan-results__scan-progress-track';
  const scanningFill = document.createElement('div');
  scanningFill.className = 'scan-results__scan-progress-fill';
  scanningInner.append(scanningFill);
  scanningTrack.append(scanningInner);
  return scanningTrack;
}

/**
 * @param {HTMLElement} countEl
 * @returns {() => void}
 */
function attachScanProgressListener(countEl) {
  if (typeof window.electronAPI.onScanProgress !== 'function') {
    return () => {};
  }
  return window.electronAPI.onScanProgress((p) => {
    if (
      p &&
      typeof p.index === 'number' &&
      typeof p.total === 'number' &&
      p.total > 0
    ) {
      countEl.textContent = `${p.index + 1} of ${p.total}`;
      countEl.title = typeof p.fileName === 'string' ? p.fileName : '';
    }
  });
}

/**
 * Disables primary actions while a folder/file scan runs.
 * @param {boolean} locked
 */
function setToolbarScanningLocked(locked) {
  folderBtn.disabled = locked;
  filesBtn.disabled = locked;
  if (locked) {
    convertBtn.disabled = true;
    if (upscaleToggle) {
      upscaleToggle.disabled = true;
    }
  } else {
    if (upscaleToggle) {
      upscaleToggle.disabled = false;
    }
    convertBtn.disabled = !hasScanTable();
  }
}

/**
 * @param {'convert' | 'abort'} mode
 */
function setConvertButtonMode(mode) {
  if (mode === 'abort') {
    convertBtn.dataset.mode = 'abort';
    convertBtn.textContent = 'Abort';
    convertBtn.classList.remove('btn--convert');
    convertBtn.classList.add('btn--abort');
    convertBtn.setAttribute('aria-label', 'Abort conversion');
  } else {
    convertBtn.dataset.mode = 'convert';
    convertBtn.textContent = CONVERT_LABEL_DEFAULT;
    convertBtn.classList.remove('btn--abort');
    convertBtn.classList.add('btn--convert');
    convertBtn.setAttribute('aria-label', CONVERT_ARIA_LABEL);
  }
}

function showScanError(errorMessage) {
  clearScanResults();
  const err = document.createElement('p');
  err.className = 'scan-results__summary';
  err.style.color = 'var(--text-muted)';
  err.textContent = `Scan failed: ${errorMessage}`;
  scanResultsEl.append(err);
  syncEmptyBrand();
}

function resetHeaderProgress() {
  headerProgressWrap.hidden = true;
  overallProgressBar.value = 0;
  overallProgressText.textContent = '0%';
  if (overallProgressFiles) {
    overallProgressFiles.textContent = '';
  }
}

/**
 * @param {string} fullPath
 * @returns {HTMLTableRowElement | null}
 */
function scanRowForPath(fullPath) {
  if (!fullPath) {
    return null;
  }
  return scanResultsEl.querySelector(`tr[data-full-path="${CSS.escape(fullPath)}"]`);
}

function resetTableRowConversionUi() {
  scanResultsEl.querySelectorAll('tr[data-full-path]').forEach((tr) => {
    tr.classList.remove('scan-results__row--convert-error');
    const bar = tr.querySelector('.scan-results__row-progress');
    const pct = tr.querySelector('.scan-results__progress-pct');
    if (bar) {
      bar.hidden = true;
      bar.value = 0;
    }
    if (pct) {
      pct.textContent = '';
    }
  });
}

/**
 * @param {string[]} inputPaths
 */
/**
 * @param {boolean} disabled
 */
function setScanSelectionControlsDisabled(disabled) {
  scanResultsEl.querySelectorAll('.scan-results__toolbar .btn-toolbar').forEach((el) => {
    el.disabled = disabled;
  });
  scanResultsEl.querySelectorAll('.scan-results__file-check').forEach((el) => {
    el.disabled = disabled;
  });
}

function prepareConversionUi(inputPaths) {
  resetTableRowConversionUi();
  resetHeaderProgress();
  headerProgressWrap.hidden = false;
  overallProgressBar.value = 0;
  overallProgressText.textContent = '0%';
  if (overallProgressFiles) {
    overallProgressFiles.textContent =
      inputPaths.length > 0 ? `1 of ${inputPaths.length}` : '';
  }
  inputPaths.forEach((p) => {
    const tr = scanRowForPath(p);
    if (!tr) {
      return;
    }
    const bar = tr.querySelector('.scan-results__row-progress');
    const pct = tr.querySelector('.scan-results__progress-pct');
    if (bar) {
      bar.hidden = false;
      bar.value = 0;
    }
    if (pct) {
      pct.textContent = '';
    }
  });
  if (upscaleToggle) {
    upscaleToggle.disabled = true;
  }
  folderBtn.disabled = true;
  filesBtn.disabled = true;
  setScanSelectionControlsDisabled(true);
}

function clearScanResults() {
  scanResultsEl.textContent = '';
  setConvertButtonMode('convert');
  convertBtn.disabled = true;
  resetHeaderProgress();
  syncEmptyBrand();
}

function hasScanTable() {
  return scanResultsEl.querySelector('table.scan-results__table') != null;
}

function formatTimeSeconds(sec) {
  if (sec == null || !Number.isFinite(sec)) {
    return '—';
  }
  const t = Math.max(0, sec);
  const s = Math.floor(t % 60);
  const m = Math.floor((t / 60) % 60);
  const h = Math.floor(t / 3600);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function extensionWithoutDot(ext) {
  if (!ext || typeof ext !== 'string') {
    return '—';
  }
  const e = ext.startsWith('.') ? ext.slice(1) : ext;
  return e.toLowerCase();
}

function formatFrameRateForDetails(fps) {
  if (fps == null || !Number.isFinite(fps)) {
    return '—';
  }
  return `${Math.round(fps)} fps`;
}

/**
 * Codec (MP4/M4V) or container label · resolution · fps · length.
 * @param {{ extension?: string, mp4Codec?: string | null, width?: number | null, height?: number | null, frameRate?: number | null, durationSec?: number | null }} row
 */
function formatDetailColumn(row) {
  const codecOrExt =
    row.extension === '.mp4' || row.extension === '.m4v'
      ? (row.mp4Codec && String(row.mp4Codec).trim()) || extensionWithoutDot(row.extension)
      : extensionWithoutDot(row.extension);

  const w = row.width;
  const h = row.height;
  const res =
    w != null && h != null && Number.isFinite(w) && Number.isFinite(h)
      ? `${Math.round(w)}×${Math.round(h)}`
      : '—';

  const fps = formatFrameRateForDetails(row.frameRate);
  const len =
    row.durationSec != null && Number.isFinite(row.durationSec)
      ? formatTimeSeconds(row.durationSec)
      : '—';

  return `${codecOrExt} · ${res} · ${fps} · ${len}`;
}

/**
 * @param {object} p
 */
function handleConvertProgressIpc(p) {
  if (!p || !p.type) {
    return;
  }

  const rowPath = typeof p.inputPath === 'string' ? p.inputPath : null;
  const tr = rowPath ? scanRowForPath(rowPath) : null;

  if (
    overallProgressFiles &&
    typeof p.index === 'number' &&
    typeof p.total === 'number' &&
    p.total > 0
  ) {
    if (p.type === 'file-start' || p.type === 'encode-tick') {
      overallProgressFiles.textContent = `${p.index + 1} of ${p.total}`;
    }
  }

  if (p.type === 'encode-tick') {
    if (typeof p.overallPercent === 'number') {
      const ov = Math.min(100, Math.max(0, p.overallPercent));
      overallProgressBar.value = Math.round(ov);
      overallProgressText.textContent = `${Math.round(ov)}%`;
    }
    if (tr) {
      const bar = tr.querySelector('.scan-results__row-progress');
      const pctEl = tr.querySelector('.scan-results__progress-pct');
      if (bar && p.percent != null) {
        bar.value = Math.round(Math.min(100, Math.max(0, p.percent)));
      }
      if (pctEl) {
        if (p.percent != null) {
          pctEl.textContent = `${Math.round(Math.min(100, Math.max(0, p.percent)))}%`;
        } else {
          pctEl.textContent = '—';
        }
      }
    }
  }

  if (p.type === 'file-done' && tr) {
    const bar = tr.querySelector('.scan-results__row-progress');
    const pctEl = tr.querySelector('.scan-results__progress-pct');
    if (bar) {
      bar.value = p.ok ? 100 : 0;
    }
    if (pctEl) {
      pctEl.textContent = p.ok ? '100%' : '—';
    }
    tr.classList.toggle('scan-results__row--convert-error', !p.ok);
  }

  if (p.type === 'overall') {
    const ov = Math.min(100, Math.max(0, p.percent));
    overallProgressBar.value = Math.round(ov);
    overallProgressText.textContent = `${Math.round(ov)}%`;
  }
}

function getCheckedInputPaths() {
  const checks = scanResultsEl.querySelectorAll('.scan-results__file-check:checked');
  return [...checks]
    .map((cb) => cb.getAttribute('data-full-path'))
    .filter((p) => typeof p === 'string' && p.length > 0);
}

function normalizeFolderKey(row) {
  return row.relativeSubfolder === ''
    ? ''
    : row.relativeSubfolder.replace(/\\/g, '/');
}

/**
 * @param {Array<{ relativeSubfolder: string }>} files
 * @returns {Array<typeof files>}
 */
function groupBySubfolder(files) {
  const map = new Map();
  for (const f of files) {
    const key = normalizeFolderKey(f);
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(f);
  }
  const keys = [...map.keys()].sort((a, b) => {
    if (a === '') {
      return -1;
    }
    if (b === '') {
      return 1;
    }
    return a.localeCompare(b);
  });
  return keys.map((k) => map.get(k));
}

/**
 * Path under the scan root, forward slashes. Falls back to normalized full path.
 * @param {string} rootPath
 * @param {string} fullPath
 */
function relativePathFromScanRoot(rootPath, fullPath) {
  if (!fullPath) {
    return '';
  }
  if (!rootPath) {
    return fullPath.replace(/\\/g, '/');
  }
  const r = rootPath.replace(/[/\\]+$/, '');
  const f = fullPath;
  if (f.length >= r.length && f.toLowerCase().startsWith(r.toLowerCase())) {
    let rest = f.slice(r.length);
    if (rest.startsWith('/') || rest.startsWith('\\')) {
      rest = rest.slice(1);
    }
    return rest.replace(/\\/g, '/') || fullPath.replace(/\\/g, '/');
  }
  return fullPath.replace(/\\/g, '/');
}

function updateSelectionCount(table, countEl) {
  const boxes = table.querySelectorAll('.scan-results__file-check');
  const checked = [...boxes].filter((c) => c.checked).length;
  const n = boxes.length;
  countEl.textContent = `${checked} of ${n} file(s) included`;
}

function attachSelectionToolbar(table) {
  const toolbar = document.createElement('div');
  toolbar.className = 'scan-results__toolbar';

  const btnRow = document.createElement('div');
  btnRow.className = 'scan-results__toolbar-buttons';

  const btnAll = document.createElement('button');
  btnAll.type = 'button';
  btnAll.className = 'btn-toolbar';
  btnAll.textContent = 'Select all';

  const btnNone = document.createElement('button');
  btnNone.type = 'button';
  btnNone.className = 'btn-toolbar';
  btnNone.textContent = 'Deselect all';

  const countEl = document.createElement('span');
  countEl.className = 'scan-results__selection-count';

  const refresh = () => updateSelectionCount(table, countEl);

  btnAll.addEventListener('click', () => {
    table.querySelectorAll('.scan-results__file-check').forEach((cb) => {
      cb.checked = true;
    });
    refresh();
  });

  btnNone.addEventListener('click', () => {
    table.querySelectorAll('.scan-results__file-check').forEach((cb) => {
      cb.checked = false;
    });
    refresh();
  });

  table.querySelectorAll('.scan-results__file-check').forEach((cb) => {
    cb.addEventListener('change', refresh);
  });

  btnRow.append(btnAll, btnNone);
  toolbar.append(btnRow, countEl);
  refresh();

  return toolbar;
}

function renderScanResults(payload) {
  clearScanResults();
  if (!payload || !payload.files) {
    return;
  }

  const { files, rootPath: scanRootPath = '' } = payload;
  const sourceKind = payload.sourceKind === 'files' ? 'files' : 'folder';

  if (files.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'scan-results__summary';
    empty.textContent =
      sourceKind === 'files'
        ? 'No supported video files in the selection (or only other types were chosen).'
        : 'No supported video files in this tree.';
    scanResultsEl.append(empty);
    convertBtn.disabled = true;
    syncEmptyBrand();
    return;
  }

  const sorted = [...files].sort((a, b) => {
    const fa = normalizeFolderKey(a);
    const fb = normalizeFolderKey(b);
    if (fa !== fb) {
      if (fa === '') {
        return -1;
      }
      if (fb === '') {
        return 1;
      }
      return fa.localeCompare(fb);
    }
    return a.fileName.localeCompare(b.fileName);
  });

  const groups = groupBySubfolder(sorted);

  const wrap = document.createElement('div');
  wrap.className = 'scan-results__table-wrap';

  const table = document.createElement('table');
  table.className = 'scan-results__table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');

  const thCheck = document.createElement('th');
  thCheck.className = 'scan-results__th-check';
  thCheck.scope = 'col';
  const thCheckLabel = document.createElement('span');
  thCheckLabel.className = 'sr-only';
  thCheckLabel.textContent = 'Include in queue';
  thCheck.append(thCheckLabel);

  const thFile = document.createElement('th');
  thFile.scope = 'col';
  thFile.textContent = 'File';

  const thDetail = document.createElement('th');
  thDetail.className = 'scan-results__th-detail';
  thDetail.scope = 'col';
  thDetail.textContent = 'Details';

  const thProgress = document.createElement('th');
  thProgress.className = 'scan-results__th-progress';
  thProgress.scope = 'col';
  thProgress.textContent = 'Progress';

  headRow.append(thCheck, thFile, thDetail, thProgress);
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement('tbody');
  let isFirstGroup = true;

  for (const gFiles of groups) {
    gFiles.forEach((row, i) => {
      const tr = document.createElement('tr');
      tr.setAttribute('data-full-path', row.fullPath);
      if (!isFirstGroup && i === 0) {
        tr.classList.add('scan-results__group-start');
      }

      const checkTd = document.createElement('td');
      checkTd.className = 'scan-results__check-cell';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'scan-results__file-check';
      cb.checked = true;
      cb.setAttribute('data-full-path', row.fullPath);
      cb.setAttribute('aria-label', `Include ${row.fileName}`);
      checkTd.append(cb);
      tr.append(checkTd);

      const fileTd = document.createElement('td');
      fileTd.className = 'scan-results__file-cell';
      fileTd.textContent = row.fileName;

      const detailTd = document.createElement('td');
      detailTd.className = 'scan-results__detail-cell';
      const detailMain = document.createElement('div');
      detailMain.textContent = formatDetailColumn(row);
      const pathHint = document.createElement('span');
      pathHint.className = 'scan-results__path-hint';
      const rel = relativePathFromScanRoot(scanRootPath, row.fullPath);
      pathHint.textContent = rel;
      pathHint.title = row.fullPath;

      detailTd.append(detailMain, pathHint);

      const progressTd = document.createElement('td');
      progressTd.className = 'scan-results__progress-cell';
      const progressInner = document.createElement('div');
      progressInner.className = 'scan-results__progress-inner';
      const rowProgress = document.createElement('progress');
      rowProgress.className = 'scan-results__row-progress';
      rowProgress.max = 100;
      rowProgress.value = 0;
      rowProgress.hidden = true;
      const progressPct = document.createElement('span');
      progressPct.className = 'scan-results__progress-pct';
      progressInner.append(rowProgress, progressPct);
      progressTd.append(progressInner);

      tr.append(fileTd, detailTd, progressTd);
      tbody.append(tr);
    });
    isFirstGroup = false;
  }

  table.append(tbody);
  wrap.append(table);

  const toolbar = attachSelectionToolbar(table);
  scanResultsEl.append(toolbar, wrap);

  setConvertButtonMode('convert');
  convertBtn.disabled = false;
  syncEmptyBrand();
}

folderBtn.addEventListener('click', async () => {
  clearScanResults();
  const result = await window.electronAPI.selectFolder();
  if (result.canceled) {
    return;
  }

  clearScanResults();
  const scanningWrap = document.createElement('div');
  scanningWrap.className = 'scan-results__scanning';
  scanningWrap.setAttribute('role', 'status');
  scanningWrap.setAttribute('aria-busy', 'true');
  const scanningLabel = document.createElement('p');
  scanningLabel.className = 'scan-results__summary';
  scanningLabel.textContent =
    'Scanning folder for legacy video files (including subfolders)';
  const scanningCount = document.createElement('p');
  scanningCount.className = 'scan-results__scan-count';
  scanningCount.setAttribute('aria-live', 'polite');
  const scanningTrack = buildIndeterminateScanBar();
  scanningWrap.append(scanningLabel, scanningCount, scanningTrack);
  scanResultsEl.append(scanningWrap);
  syncEmptyBrand();

  setToolbarScanningLocked(true);
  const unsubScan = attachScanProgressListener(scanningCount);
  let scan;
  try {
    scan = await window.electronAPI.scanLegacyVideos(result.path);
  } finally {
    unsubScan();
    setToolbarScanningLocked(false);
  }

  if (!scan.ok) {
    showScanError(scan.error);
    return;
  }

  renderScanResults(scan);
});

filesBtn.addEventListener('click', async () => {
  clearScanResults();
  const result = await window.electronAPI.selectFiles();
  if (result.canceled || result.paths.length === 0) {
    return;
  }

  clearScanResults();
  const scanningWrap = document.createElement('div');
  scanningWrap.className = 'scan-results__scanning';
  scanningWrap.setAttribute('role', 'status');
  scanningWrap.setAttribute('aria-busy', 'true');
  const scanningLabel = document.createElement('p');
  scanningLabel.className = 'scan-results__summary';
  scanningLabel.textContent = 'Reading selected files';
  const scanningCount = document.createElement('p');
  scanningCount.className = 'scan-results__scan-count';
  scanningCount.setAttribute('aria-live', 'polite');
  const scanningTrack = buildIndeterminateScanBar();
  scanningWrap.append(scanningLabel, scanningCount, scanningTrack);
  scanResultsEl.append(scanningWrap);
  syncEmptyBrand();

  setToolbarScanningLocked(true);
  const unsubScan = attachScanProgressListener(scanningCount);
  let scan;
  try {
    scan = await window.electronAPI.scanLegacyVideosFiles(result.paths);
  } finally {
    unsubScan();
    setToolbarScanningLocked(false);
  }

  if (!scan.ok) {
    showScanError(scan.error);
    return;
  }

  renderScanResults(scan);
});

convertBtn.addEventListener('click', async () => {
  if (convertBtn.dataset.mode === 'abort') {
    window.electronAPI.abortConversion();
    return;
  }

  const inputPaths = getCheckedInputPaths();
  if (inputPaths.length === 0) {
    showScanNotice('No files selected. Check at least one row in the list.');
    return;
  }

  const pick = await window.electronAPI.selectOutputFolder();
  if (pick.canceled || !pick.path) {
    return;
  }

  setConvertButtonMode('abort');

  prepareConversionUi(inputPaths);

  let unsubscribe = () => {};
  unsubscribe = window.electronAPI.onConvertProgress(handleConvertProgressIpc);

  try {
    const result = await window.electronAPI.convertLegacyFiles({
      outputDir: pick.path,
      inputPaths,
      upscale: upscaleToggle?.getAttribute('aria-pressed') === 'true',
    });

    if (!result.ok) {
      showScanNotice(`Conversion failed: ${result.error}`);
      return;
    }

    if (result.aborted) {
      showScanNotice('Conversion aborted.');
      return;
    }

    const fail = result.results.filter((r) => !r.ok).length;
    const failedNames = result.results
      .filter((r) => !r.ok)
      .map((r) => pathBasename(r.inputPath))
      .join(', ');
    if (fail > 0) {
      showScanNotice(
        `${fail} file(s) failed to convert${failedNames ? `: ${failedNames}` : ''}`
      );
    }

    const opened = await window.electronAPI.openPath(pick.path);
    if (!opened.ok && opened.error) {
      showScanNotice(`Could not open output folder: ${opened.error}`);
    }
  } catch (err) {
    showScanNotice(err instanceof Error ? err.message : String(err));
  } finally {
    unsubscribe();
    setConvertButtonMode('convert');
    convertBtn.disabled = !hasScanTable();
    if (upscaleToggle) {
      upscaleToggle.disabled = false;
    }
    folderBtn.disabled = false;
    filesBtn.disabled = false;
    setScanSelectionControlsDisabled(false);
    resetHeaderProgress();
  }
});

function pathBasename(p) {
  const s = p.replace(/[/\\]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

upscaleToggle?.addEventListener('click', () => {
  const on = upscaleToggle.getAttribute('aria-pressed') === 'true';
  upscaleToggle.setAttribute('aria-pressed', String(!on));
});

