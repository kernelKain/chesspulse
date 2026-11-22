// What: an Electron end-to-end check of the built app's first run, Help route, keyboard entry,
//      reload persistence, and the built CSP.
// Why: the renderer tests stop at the component boundary. Only a real Electron launch proves the
//      preload bridge, local preference, navigation guard, and window wiring work together.
// Removed: H-27's keyboard claim and the packaged-page startup would stay unrehearsed.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { _electron as electron } from 'playwright-core';

const ROOT = path.resolve(import.meta.dirname, '../..');

async function launch(profileRoot) {
  const env = {
    ...process.env,
    // Session files and the file log use the data root.
    XDG_DATA_HOME: path.join(profileRoot, 'data'),
    // Chromium's localStorage lives in Electron's userData under the config root.
    XDG_CONFIG_HOME: path.join(profileRoot, 'config'),
    CHESSPULSE_ENV_FILE: path.join(profileRoot, 'absent.env'),
  };
  delete env.CHESSPULSE_RENDERER_URL;
  const app = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    env,
    timeout: 60_000,
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function heading(page) {
  return (await page.getByRole('heading', { level: 1 }).innerText()).trim();
}

test('the built app explains first, keeps the preference, and serves the built CSP', async () => {
  const profileRoot = mkdtempSync(path.join(os.tmpdir(), 'chesspulse-e2e-'));
  let app;
  try {
    let page;
    ({ app, page } = await launch(profileRoot));
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    assert.equal(await heading(page), 'ChessPulse reviews your chess session after you play.');
    const csp = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute('content');
    assert.match(csp ?? '', /worker-src 'self' blob:/);
    assert.doesNotMatch(csp ?? '', /unsafe-inline|https:/);

    await page.getByRole('button', { name: 'Skip for now' }).click();
    assert.equal(await heading(page), 'Ready when you are.');

    await page.keyboard.press('Tab');
    const focused = await page.evaluate(
      () => document.activeElement?.textContent?.trim() ?? '',
    );
    assert.equal(focused, 'Start a session');

    await page.getByRole('button', { name: 'Help' }).click();
    assert.equal(await heading(page), 'Help');
    await page.getByRole('button', { name: 'Back' }).click();
    assert.equal(await heading(page), 'Ready when you are.');

    await page.reload();
    assert.equal(await heading(page), 'Ready when you are.');
    assert.deepEqual(errors, []);
    await app.close();
    app = undefined;

    ({ app, page } = await launch(profileRoot));
    assert.equal(await heading(page), 'Ready when you are.');
  } finally {
    if (app) await app.close();
    rmSync(profileRoot, { recursive: true, force: true });
  }
});
