import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { findButton, mountDom } from './dom-harness.js';
import { KeyboardHelp, KeyboardHelpHost } from './KeyboardHelp.js';

describe('KeyboardHelp interaction', () => {
  it('focuses Close, closes on Escape, and keeps Tab inside', () => {
    let closed = 0;
    const harness = mountDom(createElement(KeyboardHelp, { onClose: () => { closed += 1; } }));
    const close = findButton(harness.document, 'Close');
    assert.equal(harness.document.activeElement, close);
    harness.keyDown(close, 'Tab');
    assert.equal(harness.document.activeElement, close);
    harness.keyDown(close, 'Escape');
    assert.equal(closed, 1);
    harness.unmount();
  });

  it('opens on ? and closes on Escape', () => {
    const harness = mountDom(createElement(KeyboardHelpHost));
    assert.equal(harness.document.querySelector('[role="dialog"]'), null);
    harness.keyDown(harness.container, '?');
    assert.ok(harness.document.querySelector('[role="dialog"]'));
    assert.equal(harness.document.activeElement?.textContent, 'Close');
    harness.keyDown(harness.document.querySelector('[role="dialog"]')!, 'Escape');
    assert.equal(harness.document.querySelector('[role="dialog"]'), null);
    harness.unmount();
  });

  it('makes the app shell inert while the dialog is open', () => {
    const harness = mountDom(
      createElement(
        'div',
        null,
        createElement('div', { id: 'app-shell' }, createElement('main', null, 'content')),
        createElement(KeyboardHelpHost),
      ),
    );
    const shell = harness.document.getElementById('app-shell');
    assert.ok(shell);
    harness.keyDown(shell, '?');
    assert.equal(shell.hasAttribute('inert'), true);
    harness.keyDown(harness.document.querySelector('[role="dialog"]')!, 'Escape');
    assert.equal(shell.hasAttribute('inert'), false);
    harness.unmount();
  });

  it('does not open while typing in a text area', () => {
    const harness = mountDom(
      createElement(
        'div',
        null,
        createElement('textarea', { 'aria-label': 'Game 1' }),
        createElement(KeyboardHelpHost),
      ),
    );
    const textarea = harness.document.querySelector('textarea');
    assert.ok(textarea);
    textarea.focus();
    harness.keyDown(textarea, '?');
    assert.equal(harness.document.querySelector('[role="dialog"]'), null);
    harness.unmount();
  });
});
