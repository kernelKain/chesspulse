// What: the Electron main process. It opens one local window and nothing else.
// Why: the camera, engine, and files will live here later, outside the page.
// Removed: the renderer would have no desktop process to attach to.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, session } from 'electron';
import {
  sampleBatchSchema,
  sessionStartRequestSchema,
  sessionStartResultSchema,
  sessionStopRequestSchema,
} from '../shared/contracts.js';
import { contentSecurityPolicy } from '../shared/security.js';
import { allowsNavigation } from './navigation.js';
import { currentConsent, registerConsentHandler } from './consent.js';
import { registerPasteHandler } from './paste.js';
import { registerReportHandler } from './report-ipc.js';
import { grantsMediaPermission } from './permission.js';
import { recoverInterruptedSessions, setSampleSink, startSession, stopSession } from './session.js';
import { defaultDataRoot } from './store.js';

const SESSION_START_CHANNEL = 'cp:session:start';
const SESSION_STOP_CHANNEL = 'cp:session:stop';
const SAMPLE_CHANNEL = 'cp:sample:batch';

function publishSamples(samples: readonly unknown[]): void {
  const batch = sampleBatchSchema.parse(samples);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(SAMPLE_CHANNEL, batch);
  }
}

function appFileUrl(): string {
  return pathToFileURL(path.join(__dirname, '../../dist/index.html')).href;
}

function currentAnchor(): { monoUs: number; epochMs: number } {
  return { epochMs: Date.now(), monoUs: Math.round(performance.now() * 1000) };
}

function registerSessionHandlers(): void {
  ipcMain.handle(SESSION_START_CHANNEL, async (_event, payload: unknown) => {
    if (!currentConsent()) throw new Error('The camera stays off until you consent.');
    const parsed = sessionStartRequestSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Choose a time control before starting.');
    const meta = await startSession(defaultDataRoot(), currentAnchor(), parsed.data.timeControl);
    return sessionStartResultSchema.parse({ sessionId: meta.id });
  });
  ipcMain.handle(SESSION_STOP_CHANNEL, async (_event, payload: unknown) => {
    const parsed = sessionStopRequestSchema.safeParse(payload ?? {});
    if (!parsed.success) throw new Error('Stop does not take any details.');
    return stopSession(defaultDataRoot(), currentAnchor(), 'user');
  });
}

function installSessionGuards(): void {
  const devUrl = process.env.CHESSPULSE_RENDERER_URL;
  const urls = ['file://*'];
  let development = false;
  if (devUrl) {
    try {
      urls.push(`${new URL(devUrl).origin}/*`);
      development = true;
    } catch {
      // Navigation already rejects a dev URL that is not a URL.
    }
  }
  const policy = contentSecurityPolicy(development);

  session.defaultSession.webRequest.onHeadersReceived({ urls }, (details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });

  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
    grantsMediaPermission({
      permission,
      requestingUrl: details.requestingUrl ?? requestingOrigin,
      appFileUrl: appFileUrl(),
      consentGranted: currentConsent(),
      isMainFrame: details.isMainFrame,
      mediaType: details.mediaType,
    }),
  );

  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    callback(
      grantsMediaPermission({
        permission,
        requestingUrl: details.requestingUrl,
        appFileUrl: appFileUrl(),
        consentGranted: currentConsent(),
        isMainFrame: details.isMainFrame,
        mediaTypes,
      }),
    );
  });
}

function rendererTarget(): string {
  const devUrl = process.env.CHESSPULSE_RENDERER_URL;
  if (devUrl) return devUrl;
  return path.join(__dirname, '../../dist/index.html');
}

function createWindow(): void {
  const target = rendererTarget();
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    backgroundColor: '#0E1012',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (allowsNavigation(url, process.env.CHESSPULSE_RENDERER_URL)) return;
    event.preventDefault();
  });
  win.webContents.on('did-finish-load', () => {
    console.log('[chesspulse] window-open');
  });

  if (target.startsWith('http://') || target.startsWith('https://')) {
    void win.loadURL(target);
    return;
  }
  void win.loadFile(target);
}

app.whenReady().then(async () => {
  installSessionGuards();
  registerConsentHandler(appFileUrl());
  registerSessionHandlers();
  registerPasteHandler();
  registerReportHandler();
  setSampleSink(defaultDataRoot(), publishSamples);
  try {
    const recovery = await recoverInterruptedSessions(defaultDataRoot());
    for (const failure of recovery.failures) {
      console.error(`${failure.id}: ${failure.message}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'An open session could not be closed.');
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
