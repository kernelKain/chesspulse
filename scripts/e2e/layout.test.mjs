// What: the W5 width, reduced-motion, and keyboard-map evidence on the built app.
// Why: the plan names 960/1100/1440 and a narrow width, plus reduced motion; a component test cannot
//      see overflow or the real media query.
// Removed: H-27 would rest on a code review of media queries.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { _electron as electron } from 'playwright-core';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SHOTS = path.join(ROOT, 'docs', 'images', 'w5');
const WIDTHS = [960, 1100, 1440, 640];

async function launch(home) {
  const env = {
    ...process.env,
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    CHESSPULSE_ENV_FILE: path.join(home, 'empty.env'),
  };
  writeFileSync(env.CHESSPULSE_ENV_FILE, '');
  delete env.CHESSPULSE_RENDERER_URL;
  const app = await electron.launch({ args: ['.'], cwd: ROOT, env, timeout: 60_000 });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function noOverflow(page, label) {
  const sizes = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    main: document.querySelector('main')?.getBoundingClientRect().width ?? 0,
  }));
  assert.ok(
    sizes.scroll <= sizes.viewport + 1,
    `${label}: page scrollWidth ${sizes.scroll} exceeds viewport ${sizes.viewport}`,
  );
  assert.ok(sizes.main <= sizes.viewport, `${label}: main is wider than the viewport`);
}

test('the app fits the four widths, respects reduced motion, and opens the keyboard map', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'chesspulse-layout-'));
  let app;
  try {
    let page;
    ({ app, page } = await launch(home));
    mkdirSync(SHOTS, { recursive: true });

    assert.ok(await page.locator('.brand-mark').isVisible(), 'the first-run screen has no brand mark');
    await page.screenshot({ path: path.join(SHOTS, 'first-run.png'), fullPage: true });
    await page.getByRole('button', { name: 'Skip for now' }).click();
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), 'Ready when you are.');
      await noOverflow(page, `home ${width}`);
      // The mark must decode: a CSP-blocked or missing asset renders with naturalWidth 0.
      const mark = await page.evaluate(() => {
        const img = document.querySelector('.brand-mark');
        return img ? { width: img.getBoundingClientRect().width, natural: img.naturalWidth } : null;
      });
      assert.ok(
        mark && mark.width > 0 && mark.natural > 0,
        `home ${width}: the brand mark did not render`,
      );
      if (width >= 960) {
        assert.ok(await page.locator('.board-tile').isVisible(), `home ${width}: the board tile is hidden`);
      }
      await page.screenshot({ path: path.join(SHOTS, `home-${width}.png`), fullPage: true });

      await page.getByRole('button', { name: 'Start a session' }).click();
      assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), 'Set up your session.');
      await noOverflow(page, `setup ${width}`);
      const setupCards = await page.locator('.setup-card').count();
      assert.equal(setupCards, 3, `setup ${width}: expected 3 setup cards, found ${setupCards}`);
      if (width === 640 || width === 1440) {
        await page.screenshot({ path: path.join(SHOTS, `setup-${width}.png`), fullPage: true });
      }
      await page.getByRole('button', { name: 'Back to Home' }).click();

      await page.getByRole('button', { name: 'All sessions' }).click();
      await noOverflow(page, `sessions ${width}`);
      await page.getByRole('button', { name: 'Back to Home' }).click();

      await page.getByRole('button', { name: 'Help' }).click();
      await noOverflow(page, `help ${width}`);
      if (width === 640) {
        await page.screenshot({ path: path.join(SHOTS, 'help-640.png'), fullPage: true });
      }
      await page.getByRole('button', { name: 'Back' }).click();
      assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), 'Ready when you are.');
    }

    await page.setViewportSize({ width: 1100, height: 900 });
    const homeTabs = [];
    for (let step = 0; step < 3; step += 1) {
      await page.keyboard.press('Tab');
      homeTabs.push(
        (await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')).slice(0, 30),
      );
    }
    assert.deepEqual(homeTabs, ['Start a session', 'All sessions', 'Help']);

    await page.getByRole('button', { name: 'Start a session' }).click();
    const setupTabs = [];
    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press('Tab');
      setupTabs.push(
        (await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')).slice(0, 30),
      );
    }
    for (const label of ['Allow the camera', '1+0', '3+2', '10+0', 'Back to Home', 'Help']) {
      assert.ok(setupTabs.includes(label), `setup Tab order never reached ${label}`);
    }
    await page.getByRole('button', { name: 'Back to Home' }).click();

    await page.keyboard.press('?');
    assert.ok(await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).isVisible());
    await page.screenshot({ path: path.join(SHOTS, 'keyboard-map.png'), fullPage: true });
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);

    // Normal motion: the tile is allowed to transition, so the reduced-motion result means something.
    const tileMotion = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.board-tile-face')).transitionDuration,
    );
    assert.ok(Number.parseFloat(tileMotion) > 0, `the board tile transition is ${tileMotion}`);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const tile = await page.evaluate(() => {
      const face = document.querySelector('.board-tile-face');
      return {
        transform: face ? getComputedStyle(face).transform : '',
        transition: face ? getComputedStyle(face).transitionDuration : '',
      };
    });
    assert.notEqual(tile.transform, '', 'the board tile face is missing');
    assert.equal(Number.parseFloat(tile.transition), 0, `the board tile transition is ${tile.transition}`);
    // The tile hides below 760px; line 96 already restores 1100 after the width loop. State the
    // precondition here so a future reordering fails with a message instead of a hover timeout.
    assert.ok(await page.locator('.board-tile').isVisible(), 'the board tile is hidden; hover cannot run');
    await page.hover('.board-tile');
    const hovered = await page.evaluate(
      () => getComputedStyle(document.querySelector('.board-tile-face')).transform,
    );
    assert.equal(hovered, tile.transform, 'the board tile moved under reduced motion');

    const motion = await page.evaluate(() => {
      const dot = document.createElement('span');
      dot.className = 'recording-dot';
      document.body.append(dot);
      const animation = getComputedStyle(dot).animationName;
      dot.remove();
      return {
        fast: getComputedStyle(document.documentElement).getPropertyValue('--motion-fast').trim(),
        medium: getComputedStyle(document.documentElement).getPropertyValue('--motion-medium').trim(),
        animation,
      };
    });
    assert.equal(Number.parseFloat(motion.fast), 0, `--motion-fast is ${motion.fast}`);
    assert.equal(Number.parseFloat(motion.medium), 0, `--motion-medium is ${motion.medium}`);
    assert.equal(motion.animation, 'none', `recording dot animation is ${motion.animation}`);
  } finally {
    if (app) await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
