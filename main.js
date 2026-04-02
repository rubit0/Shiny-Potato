const electron = require('electron');
const { app, BrowserWindow, dialog, ipcMain, screen, shell, Menu, nativeImage } = electron;
const path = require('node:path');
const fs = require('node:fs');

const APP_NAME = 'Shiny Potato';

const RESOURCES_DIR = path.join(__dirname, 'resources');
const ICON_PNG = path.join(RESOURCES_DIR, 'icon.png');
const ICON_ICNS = path.join(RESOURCES_DIR, 'icon.icns');

/**
 * macOS reads the menu bar title from the running .app bundle when using the
 * `electron` CLI, so it often stays "Electron" in dev. `app.setName` still
 * helps Dock/About; use `npm run pack:mac` for a "Shiny Potato.app" build.
 */
app.setName(APP_NAME);
app.on('will-finish-launching', () => {
  app.setName(APP_NAME);
});

const { scanLegacyVideoFolder, scanLegacyVideoFiles } = require('./lib/fileScanner');
const {
  getFfmpegPath,
  getFfprobePath,
  convertLegacyFilesToMp4,
  abortCurrentConversion,
} = require('./lib/ffmpegConvert');

const CONTENT_SIZE_SCRIPT = `
(async () => {
  if (document.fonts && document.fonts.ready) {
    await document.fonts.ready;
  }
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r))
  );
  const root = document.querySelector('.app');
  const el = root || document.documentElement;
  const w = Math.ceil(
    Math.max(
      el.scrollWidth,
      el.getBoundingClientRect().width,
      document.documentElement.scrollWidth
    )
  );
  const h = Math.ceil(
    Math.max(
      el.scrollHeight,
      el.getBoundingClientRect().height,
      document.documentElement.scrollHeight
    )
  );
  return { width: w, height: h };
})()
`;

/**
 * Shared About panel (macOS sheet; Windows/Linux use Electron’s about dialog).
 * Prefer PNG for iconPath — Windows does not use .icns/.ico here.
 */
function getAboutPanelOptions() {
  const aboutOpts = {
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    credits: 'Creator: Ruben de la Torre',
  };
  if (fs.existsSync(ICON_PNG)) {
    aboutOpts.iconPath = ICON_PNG;
  } else if (process.platform === 'darwin' && fs.existsSync(ICON_ICNS)) {
    aboutOpts.iconPath = ICON_ICNS;
  }
  return aboutOpts;
}

function createWindow() {
  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: 900,
    height: 700,
    backgroundColor: '#2c2825',
    ...(fs.existsSync(ICON_PNG) ? { icon: ICON_PNG } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.once('did-finish-load', async () => {
    try {
      const { workAreaSize } = screen.getPrimaryDisplay();
      const margin = 48;
      const maxW = Math.max(320, workAreaSize.width - margin);
      const maxH = Math.max(240, workAreaSize.height - margin);

      const { width: cw, height: ch } =
        await win.webContents.executeJavaScript(CONTENT_SIZE_SCRIPT);

      const pad = 12;
      const minWin = { w: 360, h: 280 };
      const tw = Math.min(maxW, Math.max(minWin.w, cw + pad));
      const th = Math.min(maxH, Math.max(minWin.h, ch + pad));

      win.setContentSize(tw, th);
      win.center();
    } catch (err) {
      console.error('Failed to size window to content:', err);
    } finally {
      win.show();
    }
  });
}

ipcMain.handle('app:get-platform', () => process.platform);

ipcMain.handle('dialog:select-folder', async (event) => {
  const parentWindow = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(parentWindow ?? undefined, {
    properties: ['openDirectory'],
  });
  if (canceled || filePaths.length === 0) {
    return { canceled: true, path: null };
  }
  return { canceled: false, path: filePaths[0] };
});

ipcMain.handle('dialog:select-files', async (event) => {
  const parentWindow = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(parentWindow ?? undefined, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Legacy video',
        extensions: ['3gp', 'amr', 'mp4', 'm4v', 'avi', 'wmv', 'mov', 'flv', 'mpg', 'mpeg'],
      },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (canceled || filePaths.length === 0) {
    return { canceled: true, paths: [] };
  }
  return { canceled: false, paths: filePaths };
});

ipcMain.handle('scan:legacy-videos', async (event, rootPath) => {
  if (typeof rootPath !== 'string' || rootPath.trim() === '') {
    return { ok: false, error: 'Invalid path' };
  }
  try {
    const result = await scanLegacyVideoFolder(rootPath, (p) => {
      event.sender.send('scan:progress', p);
    });
    return { ok: true, ...result };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
});

ipcMain.handle('scan:legacy-videos-files', async (event, filePaths) => {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return { ok: false, error: 'No file paths' };
  }
  try {
    const result = await scanLegacyVideoFiles(filePaths, (p) => {
      event.sender.send('scan:progress', p);
    });
    return { ok: true, ...result };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
});

ipcMain.handle('dialog:select-output-folder', async (event) => {
  const parentWindow = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(parentWindow ?? undefined, {
    title: 'Choose output folder for converted MP4 files',
    buttonLabel: 'Choose folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || filePaths.length === 0) {
    return { canceled: true, path: null };
  }
  return { canceled: false, path: filePaths[0] };
});

ipcMain.handle('convert:legacy-files', async (event, payload) => {
  const outputDir = payload?.outputDir;
  const inputPaths = payload?.inputPaths;
  const upscale = payload?.upscale === true;
  if (typeof outputDir !== 'string' || outputDir.trim() === '') {
    return { ok: false, error: 'Invalid output folder' };
  }
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    return { ok: false, error: 'No input files' };
  }

  const ffmpegPath = getFfmpegPath();
  const ffprobePath = getFfprobePath();
  const sender = event.sender;

  try {
    const { results, aborted } = await convertLegacyFilesToMp4({
      ffmpegPath,
      ffprobePath,
      outputDir,
      inputPaths,
      upscale,
      onProgress: (p) => {
        sender.send('convert:progress', p);
      },
    });
    return { ok: true, results, aborted };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
});

ipcMain.handle('convert:abort', () => {
  abortCurrentConversion();
  return { ok: true };
});

ipcMain.handle('shell:open-path', async (_event, dirPath) => {
  if (typeof dirPath !== 'string' || dirPath.trim() === '') {
    return { ok: false, error: 'Invalid path' };
  }
  const err = await shell.openPath(path.normalize(dirPath.trim()));
  return { ok: err === '', error: err || undefined };
});

app.on('before-quit', () => {
  abortCurrentConversion();
});

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock && fs.existsSync(ICON_PNG)) {
    try {
      app.dock.setIcon(nativeImage.createFromPath(ICON_PNG));
    } catch {
      // ignore invalid icon
    }
  }

  app.setAboutPanelOptions(getAboutPanelOptions());

  if (process.platform === 'darwin') {
    const macMenuTemplate = [
      {
        // Label is ignored on macOS; system uses bundle display name (see note above).
        label: app.getName() || APP_NAME,
        submenu: [
          { role: 'about', label: `About ${APP_NAME}` },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide', label: `Hide ${APP_NAME}` },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit', label: `Quit ${APP_NAME}` },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: 'Window',
        submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(macMenuTemplate));
  } else if (process.platform === 'win32' || process.platform === 'linux') {
    const exitLabel = process.platform === 'win32' ? 'Exit' : 'Quit';
    const winLinuxMenuTemplate = [
      {
        label: 'File',
        submenu: [{ role: 'quit', label: `${exitLabel} ${APP_NAME}` }],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'delete' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: 'Help',
        submenu: [
          {
            label: `About ${APP_NAME}`,
            click: () => {
              app.showAboutPanel();
            },
          },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(winLinuxMenuTemplate));
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
