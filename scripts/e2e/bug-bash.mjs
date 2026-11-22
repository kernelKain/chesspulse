// What: the S58 bug bash against the built app. One fresh profile covers the first-run, Setup,
//      Sessions, Help, keyboard, and empty states; one seeded profile covers a stored session,
//      paste validation, and a below-gate refusal.
// Why: the plan requires every reachable flow and error to be exercised on the built app, not just
//      in component tests. Camera, SDK, and paid-provider paths stay with S59 and the user.
// Removed: "it looked fine in review" would be the only evidence for the reachable screens.
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { _electron as electron } from 'playwright-core';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SHOTS = path.join(ROOT, 'docs', 'images', 'bug-bash');

function dataRootFor(home) {
  return path.join(home, 'data', 'chesspulse');
}

async function launch(home) {
  const emptyEnv = path.join(home, 'empty.env');
  writeFileSync(emptyEnv, '');
  const env = {
    ...process.env,
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    CHESSPULSE_ENV_FILE: emptyEnv,
  };
  delete env.CHESSPULSE_RENDERER_URL;
  const app = await electron.launch({ args: ['.'], cwd: ROOT, env, timeout: 60_000 });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function heading(page) {
  return (await page.getByRole('heading', { level: 1 }).innerText()).trim();
}

async function shot(page, name) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

async function assertHeadingFocused(page, text) {
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent?.trim() ?? ''),
    text,
  );
}

async function skipExplainer(page) {
  if ((await heading(page)) === 'ChessPulse reviews your chess session after you play.') {
    await page.getByRole('button', { name: 'Skip for now' }).click();
  }
}

function realSessionWithSamples() {
  const base = process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, 'chesspulse', 'sessions')
    : path.join(os.homedir(), '.local', 'share', 'chesspulse', 'sessions');
  if (!existsSync(base)) return null;
  const candidates = [];
  for (const id of readdirSync(base)) {
    const dir = path.join(base, id);
    if (!statSync(dir).isDirectory()) continue;
    try {
      const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      const samples = readFileSync(path.join(dir, 'samples.ndjson'), 'utf8')
        .split('\n')
        .filter(Boolean).length;
      if (samples > 0 && meta.coverage?.pct > 0 && !existsSync(path.join(dir, 'report.json'))) {
        candidates.push({
          id,
          dir,
          startedAt: meta.startedAtEpochMs ?? 0,
          coverage: Math.floor(meta.coverage.pct),
        });
      }
    } catch {
      // An unreadable folder is not a bash candidate.
    }
  }
  candidates.sort((a, b) => b.startedAt - a.startedAt);
  return candidates[0] ?? null;
}

test('fresh profile: first run, Setup gate, Sessions, Help, keyboard', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'chesspulse-bash-fresh-'));
  let app;
  const errors = [];
  try {
    let page;
    ({ app, page } = await launch(home));
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    assert.equal(
      await heading(page),
      'ChessPulse reviews your chess session after you play.',
    );
    assert.equal(await page.locator('.explainer-steps > li').count(), 5);
    assert.equal(await page.locator('.explainer-nevers > li').count(), 3);
    assert.match(
      await page.locator('.explainer-nevers').innerText(),
      /does not give advice during a rated game/,
    );
    const firstPaintFocus = await page.evaluate(() => {
      const heading = document.querySelector('main h1');
      return {
        focused: document.activeElement === heading,
        outline: getComputedStyle(heading).outlineStyle,
      };
    });
    assert.deepEqual(firstPaintFocus, { focused: true, outline: 'none' });
    await shot(page, '01-explainer');

    await page.getByRole('button', { name: 'Skip for now' }).click();
    assert.equal(await heading(page), 'Ready when you are.');
    await page.getByText('No saved sessions yet. Start one above.').waitFor();
    await shot(page, '02-home-empty');

    await page.getByRole('button', { name: 'Start a session' }).click();
    assert.equal(await heading(page), 'Set up your session.');
    await assertHeadingFocused(page, 'Set up your session.');
    const start = page.getByRole('button', { name: 'Start sensing' });
    assert.equal(await start.isDisabled(), true);
    assert.match(await page.locator('.setup-reasons').innerText(), /Allow the camera to continue\./);
    await page.getByText(/Missing\. Set SMARTSPECTRA_API_KEY/).first().waitFor();
    assert.match(await page.locator('.setup-key').innerText(), /Missing\. Set SMARTSPECTRA_API_KEY/);
    await shot(page, '03-setup-blocked');

    await page.getByRole('button', { name: 'Allow the camera' }).click();
    await page.getByRole('button', { name: 'Revoke camera consent' }).waitFor();
    await page
      .locator('.setup-reasons')
      .getByText(/Missing\. Set SMARTSPECTRA_API_KEY/)
      .waitFor();
    assert.equal(await start.isDisabled(), true);
    await shot(page, '04-setup-no-key');

    await page.reload();
    assert.equal(await heading(page), 'Ready when you are.');
    await page.getByRole('button', { name: 'Start a session' }).click();
    assert.equal(await heading(page), 'Set up your session.');
    await page.getByRole('button', { name: 'Revoke camera consent' }).waitFor();
    await page
      .locator('.setup-reasons')
      .getByText(/Missing\. Set SMARTSPECTRA_API_KEY/)
      .waitFor();

    await page.getByRole('button', { name: 'Back to Home' }).click();
    assert.equal(await heading(page), 'Ready when you are.');

    await page.getByRole('button', { name: 'All sessions' }).click();
    assert.equal(await heading(page), 'Sessions');
    await page.getByText('No sessions yet. Start one from Home.').waitFor();
    await shot(page, '05-sessions-empty');

    await page.getByRole('button', { name: 'Help' }).click();
    assert.equal(await heading(page), 'Help');
    await assertHeadingFocused(page, 'Help');
    assert.equal(
      (await page.locator('.explainer h2').first().innerText()).trim(),
      'ChessPulse reviews your chess session after you play.',
    );
    await page.getByRole('button', { name: 'Copy diagnostics' }).click();
    await page.getByText('Diagnostics copied. They contain no games, pulse samples, or keys.').waitFor();
    await shot(page, '06-help');
    await page.getByRole('button', { name: 'Back' }).click();
    assert.equal(await heading(page), 'Sessions');
    await page.getByRole('button', { name: 'Back to Home' }).click();
    assert.equal(await heading(page), 'Ready when you are.');

    const order = [];
    for (let step = 0; step < 3; step += 1) {
      await page.keyboard.press('Tab');
      order.push(
        (await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')).slice(0, 40),
      );
    }
    assert.deepEqual(order, ['Start a session', 'All sessions', 'Help']);
    const outline = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement);
      return `${style.outlineStyle} ${style.outlineWidth}`;
    });
    assert.notEqual(outline, 'none 0px');
    await shot(page, '07-keyboard-focus');

    assert.deepEqual(errors, []);
  } finally {
    if (app) await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('seeded profile: stored session, paste validation, below-gate refusal', async (t) => {
  const source = realSessionWithSamples();
  if (!source) {
    t.skip('No real captured session with samples on this machine.');
    return;
  }
  const home = mkdtempSync(path.join(os.tmpdir(), 'chesspulse-bash-seeded-'));
  let app;
  const errors = [];
  try {
    const sessions = path.join(dataRootFor(home), 'sessions');
    mkdirSync(sessions, { recursive: true });
    cpSync(source.dir, path.join(sessions, source.id), { recursive: true });
    writeFileSync(
      path.join(sessions, 'index.json'),
      JSON.stringify({ schemaVersion: 1, ids: [source.id] }),
    );

    let page;
    ({ app, page } = await launch(home));
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await skipExplainer(page);
    assert.equal(await heading(page), 'Ready when you are.');
    await page.getByRole('button', { name: 'Open' }).first().waitFor();
    const rowText = await page.locator('.session-row').first().innerText();
    assert.match(rowText, /coverage/);
    assert.match(rowText, /No report yet/);
    assert.equal(await page.getByRole('button', { name: 'Export' }).first().isDisabled(), true);
    await shot(page, '08-session-row');

    await page.getByRole('button', { name: 'Open' }).first().click();
    await page
      .getByRole('heading', { name: 'Paste your games in order.' })
      .waitFor({ timeout: 15_000 });

    const gameOne = page.getByRole('textbox', { name: 'Game 1' });
    await gameOne.fill('this is not a pgn');
    await page.locator('.state-tag', { hasText: 'Needs fix' }).waitFor();
    assert.equal(await gameOne.getAttribute('aria-invalid'), 'true');
    assert.equal(await page.getByRole('button', { name: 'Continue to report' }).isDisabled(), true);
    await shot(page, '09-paste-invalid');

    await page.getByRole('button', { name: 'Clear game 1' }).click();
    const realPgn = readFileSync(path.join(ROOT, 'docs', 'proofs', 's4', '10+0.pgn'), 'utf8');
    await gameOne.fill(realPgn);
    await page.locator('.state-tag', { hasText: 'Partial' }).waitFor();
    assert.match(await page.locator('.banner-message').innerText(), /1 game validated\./);
    await page
      .getByText('No timestamps in these PGNs. Order follows the boxes below (oldest first).')
      .waitFor();
    assert.equal(await page.getByRole('button', { name: 'Continue to report' }).isEnabled(), true);
    await shot(page, '10-paste-real');

    const illegal = realPgn.replace('1. d4', '1. e5');
    await gameOne.fill(illegal);
    await page.locator('.state-tag', { hasText: 'Needs fix' }).waitFor();
    assert.match(
      await page.locator('.slot-error').first().innerText(),
      /Game 1, move 1 \(e5\) is not legal/,
    );
    await shot(page, '11-paste-illegal');

    await gameOne.fill(realPgn);
    await page.locator('.state-tag', { hasText: 'Partial' }).waitFor();
    await page.getByRole('button', { name: 'Continue to report' }).click();
    await page.getByRole('heading', { name: 'Review withheld.' }).waitFor({ timeout: 20_000 });
    const refusal = await page.locator('.refusal-panel').innerText();
    assert.match(refusal, new RegExp(`Coverage was ${source.coverage}%`));
    assert.match(refusal, /70%/);
    assert.match(refusal, /lighting or moving out of frame/);
    assert.equal(existsSync(path.join(sessions, source.id, 'report.json')), false);
    await shot(page, '12-refusal');

    await page.getByRole('button', { name: 'Home' }).click();
    assert.equal(await heading(page), 'Ready when you are.');
    await page.getByRole('button', { name: 'All sessions' }).click();
    assert.equal(await heading(page), 'Sessions');
    await page.getByRole('button', { name: 'Delete' }).first().click();
    await page.getByText('Delete this session? This cannot be undone.').waitFor();
    assert.equal(
      await page.evaluate(() => document.activeElement?.textContent?.trim() ?? ''),
      'Cancel',
    );
    await shot(page, '13-delete-confirm');
    await page.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(
      await page.evaluate(() => document.activeElement?.textContent?.trim() ?? ''),
      'Delete',
    );
    assert.deepEqual(errors, []);
  } finally {
    if (app) await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
