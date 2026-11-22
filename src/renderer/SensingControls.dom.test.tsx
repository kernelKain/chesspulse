import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { findButton, mountDom } from './dom-harness.js';
import { SensingControls, type SensingControlsProps } from './SensingControls.js';

function props(overrides: Partial<SensingControlsProps> = {}): SensingControlsProps {
  return {
    elapsedLabel: '12:34',
    limitWarning: null,
    qualityLabel: 'Good signal',
    betweenGames: false,
    markedGames: 0,
    gapPending: false,
    confirmingStop: false,
    onGap: () => undefined,
    onRequestStop: () => undefined,
    onConfirmStop: () => undefined,
    onKeepSensing: () => undefined,
    ...overrides,
  };
}

describe('SensingControls interaction', () => {
  it('moves focus to Keep sensing when the confirmation opens', () => {
    const harness = mountDom(
      createElement(SensingControls, props({ confirmingStop: true })),
    );
    assert.equal(harness.document.activeElement?.textContent, 'Keep sensing');
    harness.unmount();
  });

  it('keeps sensing on Escape without confirming', () => {
    let kept = 0;
    let stopped = 0;
    const harness = mountDom(
      createElement(
        SensingControls,
        props({
          confirmingStop: true,
          onKeepSensing: () => {
            kept += 1;
          },
          onConfirmStop: () => {
            stopped += 1;
          },
        }),
      ),
    );
    const group = harness.document.querySelector('.stop-confirm');
    assert.ok(group);
    harness.keyDown(group, 'Escape');
    assert.equal(kept, 1);
    assert.equal(stopped, 0);
    harness.unmount();
  });

  it('returns focus to Stop sensing when the confirmation closes', () => {
    const harness = mountDom(
      createElement(SensingControls, props({ confirmingStop: true })),
    );
    harness.render(createElement(SensingControls, props({ confirmingStop: false })));
    assert.equal(harness.document.activeElement?.textContent, 'Stop sensing');
    harness.unmount();
  });

  it('requests a stop from the Stop sensing button', () => {
    let requested = 0;
    const harness = mountDom(
      createElement(
        SensingControls,
        props({
          onRequestStop: () => {
            requested += 1;
          },
        }),
      ),
    );
    harness.click(findButton(harness.document, 'Stop sensing'));
    assert.equal(requested, 1);
    harness.unmount();
  });
});
