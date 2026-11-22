import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CameraOpenIndicator } from './CameraOpenIndicator.js';

describe('CameraOpenIndicator markup', () => {
  it('renders nothing when the camera is closed', () => {
    assert.equal(
      renderToStaticMarkup(createElement(CameraOpenIndicator, { sensing: false, preview: false })),
      '',
    );
  });

  it('says Sensing with a decorative dot', () => {
    const html = renderToStaticMarkup(
      createElement(CameraOpenIndicator, { sensing: true, preview: false }),
    );
    assert.match(html, /Sensing/);
    assert.match(html, /class="recording-dot" aria-hidden="true"/);
  });

  it('distinguishes a setup preview from a session', () => {
    const html = renderToStaticMarkup(
      createElement(CameraOpenIndicator, { sensing: false, preview: true }),
    );
    assert.match(html, /Camera preview/);
    assert.equal(html.includes('>Sensing<'), false);
  });
});
