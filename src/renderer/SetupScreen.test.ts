import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FramingChecks } from '../shared/framing.js';
import { setupGate, type SetupGateInput } from '../shared/setup.js';
import { SetupScreen, type SetupScreenProps } from './SetupScreen.js';

const readyFraming: FramingChecks = { face: 'pass', chest: 'pass', light: 'pass' };

function gateFor(overrides: Partial<SetupGateInput> = {}) {
  return setupGate({
    consent: true,
    keyStatus: 'present',
    keyDetail: 'Present (value not shown).',
    preview: 'running',
    framing: readyFraming,
    ...overrides,
  });
}

function render(overrides: Partial<SetupScreenProps> = {}): string {
  const props: SetupScreenProps = {
    consent: true,
    keyStatus: 'present',
    keyDetail: 'Present (value not shown).',
    framing: readyFraming,
    framingHint: null,
    preview: 'running',
    previewError: null,
    starting: false,
    previewSlot: createElement('div', null, 'Live preview'),
    timeControls: ['1+0', '3+2', '10+0'],
    timeControl: '3+2',
    gate: gateFor(),
    onConsent: () => undefined,
    onTimeControl: () => undefined,
    onStart: () => undefined,
    onRetryPreview: () => undefined,
    onBack: () => undefined,
    onHelp: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(SetupScreen, props));
}

describe('SetupScreen markup', () => {
  it('shows all four setup areas and three framing checks', () => {
    const html = render();
    assert.match(html, /1\. Consent and key/);
    assert.match(html, /2\. Framing/);
    assert.match(html, /3\. Time control/);
    assert.match(html, /One face in view/);
    assert.match(html, /Upper chest visible/);
    assert.match(html, /Enough light/);
    assert.match(html, />Start sensing</);
  });

  it('disables Start until consent and shows the reason', () => {
    const html = render({ consent: false, gate: gateFor({ consent: false }) });
    assert.match(html, /<button[^>]*disabled[^>]*>Start sensing<\/button>/);
    assert.match(html, /Allow the camera to continue/);
  });

  it('shows the missing key variable and no framing preview', () => {
    const html = render({
      keyStatus: 'missing',
      keyDetail: 'Missing. Set SMARTSPECTRA_API_KEY in .env or the environment.',
      preview: 'idle',
      previewSlot: null,
      gate: gateFor({ keyStatus: 'missing', preview: 'idle' }),
    });
    assert.match(html, /SMARTSPECTRA_API_KEY/);
    assert.match(html, /<button[^>]*disabled[^>]*>Start sensing<\/button>/);
    assert.equal(html.includes('Live preview'), false);
  });

  it('keeps Start disabled when one framing check is not passing', () => {
    const framing: FramingChecks = { face: 'pass', chest: 'fail', light: 'unknown' };
    const html = render({
      framing,
      framingHint: 'Sit back so your chest is in frame.',
      gate: gateFor({ framing }),
    });
    assert.match(html, /Framing must pass all three checks/);
    assert.match(html, /Sit back so your chest is in frame\./);
    assert.match(html, /Fix/);
    assert.match(html, /Waiting/);
    assert.match(html, /<button[^>]*disabled[^>]*>Start sensing<\/button>/);
  });

  it('enables Start only when the gate says every check passed', () => {
    const html = render({ gate: gateFor() });
    assert.equal(html.includes('disabled'), false);
    assert.match(html, /All checks pass\. Start when you are ready\./);
  });

  it('exposes every time control as a pressed-state button', () => {
    const html = render();
    for (const control of ['1+0', '3+2', '10+0']) assert.ok(html.includes(`>${control}<`));
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 2);
  });

  it('offers a retry after a preview failure and blocks Start while starting', () => {
    const failed = render({
      preview: 'error',
      previewError: 'Camera is busy.',
      previewSlot: null,
      gate: gateFor({ preview: 'error', previewError: 'Camera is busy.' }),
    });
    assert.match(failed, /Try the preview again/);
    assert.match(failed, /Camera is busy\./);

    const starting = render({ starting: true });
    assert.match(starting, /Starting…/);
    assert.match(starting, /<button[^>]*disabled[^>]*>Starting…<\/button>/);
  });
});
