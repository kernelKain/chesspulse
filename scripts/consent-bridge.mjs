// What: opens the built page in a hidden window and calls the consent bridge.
// Why: the unit tests do not load Electron, so they cannot see the preload or a file:// URL.
// Removed: a broken bridge would still look green in the Node tests.
// Prerequisite: dist/index.html and dist-electron/ must already exist. This file is not a
// standalone test. Run it through `npm run test:consent`, which builds both outputs first.
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const page = pathToFileURL(path.join(root, 'dist/index.html')).href;
const { registerConsentHandler } = require(path.join(root, 'dist-electron/main/consent.js'));
const { deserializeAppError } = require(path.join(root, 'dist-electron/shared/errors.js'));

app.whenReady().then(async () => {
  registerConsentHandler({ appFileUrl: page });
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(root, 'dist-electron/preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  await win.loadURL(page);
  const allowed = await win.webContents.executeJavaScript('window.chesspulse.setConsent(true)', true);
  const revoked = await win.webContents.executeJavaScript('window.chesspulse.setConsent(false)', true);
  const bad = await win.webContents.executeJavaScript(
    'window.chesspulse.setConsent("yes").then(() => "accepted", (error) => error.message)',
    true,
  );
  const badError = deserializeAppError(bad);
  const ok =
    allowed?.granted === true &&
    allowed?.cameraAllowed === true &&
    revoked?.granted === false &&
    revoked?.cameraAllowed === false &&
    badError?.code === 'invalid_request';
  console.log(JSON.stringify({ allowed, revoked, bad, badCode: badError?.code ?? null, ok }));
  app.exit(ok ? 0 : 1);
}).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  app.exit(1);
});
