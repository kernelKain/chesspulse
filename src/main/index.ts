// What: the Electron main process. It opens one local window and owns the camera, never the page.
// Why: the SmartSpectra key and native runtime stay here, so the page receives only numbers.
// Removed: the renderer would have no desktop process to attach to, and no way to sense.
// The native override must be the first import: the SDK loads its shared library at import time.
import './native-runtime.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, session } from 'electron';
import {
  coachMessageSchema,
  consentStateSchema,
  previewFrameSchema,
  previewStartResultSchema,
  previewStopResultSchema,
  sampleBatchSchema,
  sdkErrorSchema,
  sessionStartResultSchema,
  sessionStartedSchema,
  validationMessageSchema,
  type PreviewFrame,
  type SdkError,
  type SessionEndReason,
  type SessionMeta,
  type ValidationMessage,
} from '../shared/contracts.js';
import { EVENT_CHANNELS } from '../shared/channels.js';
import { contentSecurityPolicy } from '../shared/security.js';
import { AppError, toAppError } from '../shared/errors.js';
import { allowsNavigation } from './navigation.js';
import { readAppState } from './app-state.js';
import { startCapture, type CaptureSession } from './capture.js';
import { BetweenGamesCoach } from './coach.js';
import { currentConsent, registerConsentHandler } from './consent.js';
import { loadEnvCandidates, readSensingKey } from './env.js';
import { installFileLog, installSafeConsole, log, logError } from './log.js';
import { registerDiagnosticsHandler } from './diagnostics-ipc.js';
import { runDoctor } from './doctor.js';
import { registerInsightHandler } from './insight-ipc.js';
import { registerInvokeChannel } from './ipc-registry.js';
import { configureIpcSender } from './ipc-sender.js';
import { registerLibraryHandler } from './library-ipc.js';
import { registerPasteHandler } from './paste.js';
import { createPreviewController } from './preview.js';
import { registerReportHandler } from './report-ipc.js';
import { registerSetupHandler } from './setup-ipc.js';
import { grantsMediaPermission } from './permission.js';
import {
  activeSessionState,
  hasActiveSession,
  ingestSamples,
  isActiveSession,
  recoverInterruptedSessions,
  setSampleSink,
  startSession,
  stopSession,
  type SessionStopReason,
} from './session.js';
import { createSessionStopper } from './session-stop.js';
import { createShutdownHooks } from './shutdown.js';
import { defaultDataRoot } from './store.js';

let capture: CaptureSession | null = null;
let coach: BetweenGamesCoach | null = null;
/** One camera preview outside a session. Samples are discarded; only frames and hints are published. */
const preview = createPreviewController(startCapture);
/** One stop at a time. Every caller shares this promise, so the session is finalized exactly once. */
let stoppingSession: Promise<SessionMeta> | null = null;
/** True from admission until the start flow settles; preview must not take the reserved camera. */
let sessionStarting = false;

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
    try {
      win.webContents.send(channel, payload);
    } catch {
      // The window closed between the check and the send. Nothing else consumes this event.
    }
  }
}

function publishSamples(samples: readonly unknown[]): void {
  const parsed = sampleBatchSchema.parse(samples);
  publishToWindows(EVENT_CHANNELS.samples, parsed);
  // Only batches already committed to the session file can trigger the coach.
  const message = coach?.ingest(parsed);
  if (message) publishToWindows(EVENT_CHANNELS.coachMessage, coachMessageSchema.parse(message));
}

let lastValidationCode: number | null = null;

function publishValidation(message: ValidationMessage): void {
  const parsed = validationMessageSchema.parse(message);
  if (parsed.code !== lastValidationCode) {
    lastValidationCode = parsed.code;
    log(`[chesspulse] sensing hint ${parsed.code}: ${parsed.hint}`);
  }
  publishToWindows(EVENT_CHANNELS.validation, parsed);
}

function publishPreview(frame: PreviewFrame): void {
  publishToWindows(EVENT_CHANNELS.preview, previewFrameSchema.parse(frame));
}

function publishSdkError(error: SdkError): void {
  const parsed = sdkErrorSchema.parse(error);
  // The page shows this; the terminal keeps the code so a failure can be diagnosed after the fact.
  logError(`[chesspulse] sensing error ${parsed.code}: ${parsed.message} (retryable=${parsed.retryable})`);
  publishToWindows(EVENT_CHANNELS.sdkError, parsed);
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
  publish: (event) => publishToWindows(EVENT_CHANNELS.sessionEnded, event),
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
  stop: async () => {
    // A preview-only quit still has to release the camera before the window closes.
    await preview.stop();
    return stopEverything('user');
  },
  hasActive: () => capture !== null || stoppingSession !== null || preview.active() || sessionStarting,
  quit: () => app.quit(),
});

function appFileUrl(): string {
  return pathToFileURL(path.join(__dirname, '../../dist/index.html')).href;
}

function currentAnchor(): { monoUs: number; epochMs: number } {
  return { epochMs: Date.now(), monoUs: Math.round(performance.now() * 1000) };
}

function registerSessionHandlers(): void {
  registerInvokeChannel('appStateGet', (event) => {
    const granted = currentConsent();
    return readAppState({
      consent: () =>
        consentStateSchema.parse({
          granted,
          cameraAllowed: grantsMediaPermission({
            permission: 'media',
            requestingUrl: event.senderFrame?.url,
            appFileUrl: appFileUrl(),
            devOrigin: rendererDevOrigin(),
            consentGranted: granted,
            isMainFrame: true,
            mediaTypes: ['video'],
          }),
        }),
      session: () => ({
        ...activeSessionState(defaultDataRoot()),
        betweenGames: coach?.isBetweenGames ?? false,
        markedGames: coach?.markedGameCount ?? 0,
      }),
    });
  });
  registerInvokeChannel('previewStart', async () => {
    if (!currentConsent()) throw new AppError('consent_required');
    if (capture || sessionStarting || hasActiveSession(defaultDataRoot())) {
      throw new AppError('session_busy');
    }
    const apiKey = readSensingKey(process.env);
    if (!apiKey) throw new AppError('key_missing');
    lastValidationCode = null;
    try {
      await preview.start(
        {
          apiKey,
          anchor: currentAnchor(),
          events: {
            // Framing only: preview samples never enter a session or the store.
            onSamples: () => undefined,
            onValidation: publishValidation,
            onError: (error) => {
              publishSdkError(error);
              if (!error.retryable) void preview.stop();
            },
            onPreview: publishPreview,
            onEnded: () => undefined,
          },
        },
        () => {
          // Runs inside the serialized controller, immediately before native capture is created.
          if (!currentConsent()) throw new AppError('consent_required');
          if (capture || sessionStarting) throw new AppError('session_busy');
        },
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('camera_unavailable', { cause: error });
    }
    return previewStartResultSchema.parse({ started: true });
  });
  registerInvokeChannel('previewStop', async () => {
    await preview.stop();
    return previewStopResultSchema.parse({ stopped: true });
  });
  async function startSessionFlow(payload: { timeControl: string }): Promise<unknown> {
    if (!currentConsent()) throw new AppError('consent_required');
    if (capture) throw new AppError('session_busy');
    shutdownHooks.beginStart();
    // The preview and the session cannot own the native camera at the same time.
    await preview.stop();
    // A previous stop may still be draining the camera; the SDK is process-global.
    if (stoppingSession) await stoppingSession.catch(() => undefined);
    if (!shutdownHooks.captureAllowed()) throw new AppError('session_failed');
    const apiKey = readSensingKey(process.env);
    if (!apiKey) throw new AppError('key_missing');
    const anchor = currentAnchor();
    lastValidationCode = null;
    if (!hasActiveSession(defaultDataRoot())) sessionStopper.beginSession();
    const meta = await startSession(defaultDataRoot(), anchor, payload.timeControl, {
      onLimit: () => {
        void stopEverything('limit').catch((error: unknown) => {
          // The session is already in 'stopping', so it cannot accept over-limit samples; the
          // failure is still recorded so a stop can be retried with the cause visible.
          logError(
            `[chesspulse] limit stop failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
        });
      },
    });
    if (!shutdownHooks.captureAllowed()) {
      await stopEverything('user').catch(() => undefined);
      throw new AppError('session_failed');
    }
    // A stop can finalize this session while startSession is still awaiting work. If a newer
    // session is active instead, never stop it and never open capture against A's anchor.
    if (stoppingSession || !isActiveSession(defaultDataRoot(), meta.id)) {
      throw new AppError('session_failed');
    }
    coach = new BetweenGamesCoach(meta.startAnchor.monoUs);
    // Consent can be withdrawn while the header is written. Checked again immediately before the
    // camera opens, with no await in between, so a revocation cannot slip through.
    if (!currentConsent()) {
      await stopEverything('user').catch(() => undefined);
      throw new AppError('consent_required');
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
            if (reason === 'storage') {
              void stopEverything('storage').catch((error: unknown) => {
                logError(
                  `[chesspulse] storage stop failed: ${error instanceof Error ? error.message : 'unknown error'}`,
                );
              });
            }
          },
        },
      });
    } catch (error) {
      await stopEverything('sdkError').catch(() => undefined);
      throw new AppError('camera_unavailable', { cause: error });
    }
    // Published after capture is open. A page that reloaded during the start invoke can adopt it.
    publishToWindows(
      EVENT_CHANNELS.sessionStarted,
      sessionStartedSchema.parse({ sessionId: meta.id, startedAtEpochMs: meta.startedAtEpochMs }),
    );
    return sessionStartResultSchema.parse({
      sessionId: meta.id,
      startedAtEpochMs: meta.startedAtEpochMs,
    });
  }

  registerInvokeChannel('sessionStart', async (_event, payload) => {
    if (sessionStarting) throw new AppError('session_busy');
    sessionStarting = true;
    try {
      return await startSessionFlow(payload);
    } finally {
      sessionStarting = false;
    }
  });
  registerInvokeChannel('sessionStop', async () =>
    stopEverything('user').catch((error: unknown) => {
      throw toAppError(error, 'session_failed');
    }),
  );
  registerInvokeChannel('coachGap', (_event, payload) => {
    if (!coach) throw new AppError('session_not_running');
    const message = coach.setBetweenGames(payload.betweenGames);
    if (message) publishToWindows(EVENT_CHANNELS.coachMessage, coachMessageSchema.parse(message));
    return payload;
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
  const besideExecutable = process.env.APPIMAGE
    ? path.dirname(process.env.APPIMAGE)
    : path.dirname(app.getPath('exe'));
  const env = loadEnvCandidates(
    [
      process.env.CHESSPULSE_ENV_FILE ?? '',
      app.isPackaged ? path.join(besideExecutable, '.env') : path.join(app.getAppPath(), '.env'),
      app.isPackaged ? path.join(app.getPath('userData'), '.env') : '',
    ],
    process.env,
  );
  installFileLog({ root: defaultDataRoot(), env: process.env });
  log('[chesspulse] application ready');
  if (env.found && env.loadedKeys.length > 0) {
    log(`[chesspulse] loaded ${env.loadedKeys.length} setting(s) from .env`);
  }
  installSessionGuards();
  configureIpcSender({ appFileUrl: appFileUrl(), devOrigin: rendererDevOrigin() });
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
  registerLibraryHandler(defaultDataRoot);
  registerDiagnosticsHandler(defaultDataRoot, {
    doctorLines: async () =>
      (await runDoctor({ env: process.env, envFile: env, dataRoot: defaultDataRoot() })).lines,
  });
  registerSetupHandler({ env: process.env, envFile: env, dataRoot: defaultDataRoot() });
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
