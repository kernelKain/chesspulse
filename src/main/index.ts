// What: the Electron main process. It opens one local window and owns the camera, never the page.
// Why: the SmartSpectra key and native runtime stay here, so the page receives only numbers.
// Removed: the renderer would have no desktop process to attach to, and no way to sense.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, session } from 'electron';
import {
  coachGapRequestSchema,
  coachMessageSchema,
  previewFrameSchema,
  sampleBatchSchema,
  sdkErrorSchema,
  sessionStartRequestSchema,
  sessionStartResultSchema,
  sessionStopRequestSchema,
  validationMessageSchema,
  type PreviewFrame,
  type SdkError,
  type SessionEndReason,
  type SessionMeta,
  type ValidationMessage,
} from '../shared/contracts.js';
import { contentSecurityPolicy } from '../shared/security.js';
import { allowsNavigation } from './navigation.js';
import { startCapture, type CaptureSession } from './capture.js';
import { BetweenGamesCoach } from './coach.js';
import { currentConsent, registerConsentHandler } from './consent.js';
import { loadEnvFile, readSensingKey } from './env.js';
import { installSafeConsole, log, logError } from './log.js';
import { registerInsightHandler } from './insight-ipc.js';
import { registerPasteHandler } from './paste.js';
import { registerReportHandler } from './report-ipc.js';
import { grantsMediaPermission } from './permission.js';
import {
  ingestSamples,
  recoverInterruptedSessions,
  setSampleSink,
  startSession,
  stopSession,
  type SessionStopReason,
} from './session.js';
import { createSessionStopper } from './session-stop.js';
import { createShutdownHooks } from './shutdown.js';
import { defaultDataRoot } from './store.js';

const SESSION_START_CHANNEL = 'cp:session:start';
const SESSION_STOP_CHANNEL = 'cp:session:stop';
const SAMPLE_CHANNEL = 'cp:sample:batch';
const VALIDATION_CHANNEL = 'cp:validation';
const SDK_ERROR_CHANNEL = 'cp:sdk:error';
const PREVIEW_CHANNEL = 'cp:preview';
const COACH_GAP_CHANNEL = 'cp:coach:gap';
const COACH_MESSAGE_CHANNEL = 'cp:coach:message';
const SESSION_ENDED_CHANNEL = 'cp:session:ended';

let capture: CaptureSession | null = null;
let coach: BetweenGamesCoach | null = null;
/** One stop at a time. Every caller shares this promise, so the session is finalized exactly once. */
let stoppingSession: Promise<SessionMeta> | null = null;

function rendererDevOrigin(): string | undefined {
  const devUrl = process.env.CHESSPULSE_RENDERER_URL;
  if (!devUrl) return undefined;
  try {
    const url = new URL(devUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function publishToWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(channel, payload);
  }
}

function publishSamples(samples: readonly unknown[]): void {
  const parsed = sampleBatchSchema.parse(samples);
  publishToWindows(SAMPLE_CHANNEL, parsed);
  // Only batches already committed to the session file can trigger the coach.
  const message = coach?.ingest(parsed);
  if (message) publishToWindows(COACH_MESSAGE_CHANNEL, coachMessageSchema.parse(message));
}

let lastValidationCode: number | null = null;

function publishValidation(message: ValidationMessage): void {
  const parsed = validationMessageSchema.parse(message);
  if (parsed.code !== lastValidationCode) {
    lastValidationCode = parsed.code;
    log(`[chesspulse] sensing hint ${parsed.code}: ${parsed.hint}`);
  }
  publishToWindows(VALIDATION_CHANNEL, parsed);
}

function publishPreview(frame: PreviewFrame): void {
  publishToWindows(PREVIEW_CHANNEL, previewFrameSchema.parse(frame));
}

function publishSdkError(error: SdkError): void {
  const parsed = sdkErrorSchema.parse(error);
  // The page shows this; the terminal keeps the code so a failure can be diagnosed after the fact.
  logError(`[chesspulse] sensing error ${parsed.code}: ${parsed.message} (retryable=${parsed.retryable})`);
  publishToWindows(SDK_ERROR_CHANNEL, parsed);
}

/** The camera is released before the session closes, so the last batch still has a session to land in. */
async function stopCapture(): Promise<SessionEndReason | undefined> {
  const current = capture;
  capture = null;
  coach = null;
  lastValidationCode = null;
  if (!current) return undefined;
  try {
    return await current.stop();
  } catch {
    // Best effort. Samples already written stay valid; crash recovery closes the header.
    return undefined;
  }
}

const sessionStopper = createSessionStopper({
  stopCapture,
  stopSession: (reason) => stopSession(defaultDataRoot(), currentAnchor(), reason),
  publish: (event) => publishToWindows(SESSION_ENDED_CHANNEL, event),
});

/**
 * Releases the camera, then closes the header. The page, consent withdrawal, the window closing
 * and quitting all share one promise: nobody proceeds while the native teardown is still draining,
 * and the session is never finalized twice.
 */
function stopEverything(reason: SessionStopReason): Promise<SessionMeta> {
  if (stoppingSession) return stoppingSession;
  const run = sessionStopper.stop(reason);
  stoppingSession = run.finally(() => {
    stoppingSession = null;
  });
  return stoppingSession;
}

const shutdownHooks = createShutdownHooks({
  stop: () => stopEverything('user'),
  hasActive: () => capture !== null || stoppingSession !== null,
  quit: () => app.quit(),
});

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
    if (capture) throw new Error('A session is already running.');
    // A previous stop may still be draining the camera; the SDK is process-global.
    if (stoppingSession) await stoppingSession.catch(() => undefined);
    const apiKey = readSensingKey(process.env);
    if (!apiKey) throw new Error('The SmartSpectra key is missing. Add SMARTSPECTRA_API_KEY to .env.');
    const anchor = currentAnchor();
    lastValidationCode = null;
    const meta = await startSession(defaultDataRoot(), anchor, parsed.data.timeControl, {
      onLimit: () => {
        void stopEverything('limit').catch(() => undefined);
      },
    });
    coach = new BetweenGamesCoach(meta.startAnchor.monoUs);
    // Consent can be withdrawn while the header is written. Checked again immediately before the
    // camera opens, with no await in between, so a revocation cannot slip through.
    if (!currentConsent()) {
      await stopEverything('user').catch(() => undefined);
      throw new Error('The camera stays off until you consent.');
    }
    try {
      capture = startCapture({
        apiKey,
        anchor: meta.startAnchor,
        events: {
          onSamples: (samples) => ingestSamples(defaultDataRoot(), samples),
          onValidation: publishValidation,
          onError: publishSdkError,
          onPreview: publishPreview,
          onEnded: (reason) => {
            if (reason === 'storage') void stopEverything('storage').catch(() => undefined);
          },
        },
      });
    } catch (error) {
      await stopEverything('sdkError').catch(() => undefined);
      throw error;
    }
    return sessionStartResultSchema.parse({ sessionId: meta.id });
  });
  ipcMain.handle(SESSION_STOP_CHANNEL, async (_event, payload: unknown) => {
    const parsed = sessionStopRequestSchema.safeParse(payload ?? {});
    if (!parsed.success) throw new Error('Stop does not take any details.');
    return stopEverything('user');
  });
  ipcMain.handle(COACH_GAP_CHANNEL, (_event, payload: unknown) => {
    const parsed = coachGapRequestSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Mark the game boundary as either between games or playing.');
    if (!coach) throw new Error('Start sensing before marking a game boundary.');
    const message = coach.setBetweenGames(parsed.data.betweenGames);
    if (message) publishToWindows(COACH_MESSAGE_CHANNEL, coachMessageSchema.parse(message));
    return parsed.data;
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
      devOrigin: rendererDevOrigin(),
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
        devOrigin: rendererDevOrigin(),
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
      // The player focuses another window to play chess. Throttled frames would starve the
      // measurement, so the page must keep its timers and frame callbacks at full rate.
      backgroundThrottling: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (allowsNavigation(url, process.env.CHESSPULSE_RENDERER_URL)) return;
    event.preventDefault();
  });
  win.webContents.on('did-finish-load', () => {
    log('[chesspulse] window-open');
  });

  if (target.startsWith('http://') || target.startsWith('https://')) {
    void win.loadURL(target);
    return;
  }
  void win.loadFile(target);
}

installSafeConsole();

app.whenReady().then(async () => {
  const env = loadEnvFile(path.join(app.getAppPath(), '.env'), process.env);
  if (env.found && env.loadedKeys.length > 0) {
    log(`[chesspulse] loaded ${env.loadedKeys.length} setting(s) from .env`);
  }
  installSessionGuards();
  registerConsentHandler(
    { appFileUrl: appFileUrl(), devOrigin: rendererDevOrigin() },
    {
      onRevoked: shutdownHooks.onConsentRevoked,
    },
  );
  registerSessionHandlers();
  registerPasteHandler();
  registerReportHandler();
  registerInsightHandler();
  setSampleSink(defaultDataRoot(), publishSamples);
  try {
    const recovery = await recoverInterruptedSessions(defaultDataRoot());
    for (const failure of recovery.failures) {
      logError(`${failure.id}: ${failure.message}`);
    }
  } catch (error) {
    logError(error instanceof Error ? error.message : 'An open session could not be closed.');
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', (event) => {
  shutdownHooks.onBeforeQuit(event);
});

app.on('window-all-closed', () => {
  // Closing the last window ends the session, on every platform. Quitting then waits for it.
  shutdownHooks.onWindowAllClosed();
  if (process.platform !== 'darwin') app.quit();
});
