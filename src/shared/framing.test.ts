import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  UNKNOWN_FRAMING,
  VALIDATION,
  framingFromValidation,
  framingReady,
  framingStatusText,
} from './framing.js';

describe('framing checks', () => {
  it('passes all three checks only on the SDK ok code', () => {
    assert.deepEqual(framingFromValidation(VALIDATION.ok), {
      face: 'pass',
      chest: 'pass',
      light: 'pass',
    });
    assert.equal(framingReady(framingFromValidation(VALIDATION.ok)), true);
    assert.equal(framingReady(UNKNOWN_FRAMING), false);
  });

  it('marks the chest as the failing check while keeping the face pass', () => {
    const checks = framingFromValidation(VALIDATION.chestNotVisible);
    assert.deepEqual(checks, { face: 'pass', chest: 'fail', light: 'unknown' });
    assert.equal(framingReady(checks), false);
  });

  it('marks the face as failing for a face code', () => {
    for (const code of [
      VALIDATION.noFaceFound,
      VALIDATION.multipleFacesFound,
      VALIDATION.faceNotCentered,
      VALIDATION.faceSizeOutOfRange,
      VALIDATION.faceTooClose,
      VALIDATION.faceTooFar,
      VALIDATION.faceTooHigh,
      VALIDATION.faceTooLow,
      VALIDATION.faceNotForward,
    ]) {
      assert.equal(framingFromValidation(code).face, 'fail', String(code));
      assert.equal(framingFromValidation(code).chest, 'unknown', String(code));
    }
  });

  it('marks light as failing for dark or bright frames', () => {
    for (const code of [VALIDATION.tooDark, VALIDATION.tooBright]) {
      assert.deepEqual(framingFromValidation(code), {
        face: 'unknown',
        chest: 'unknown',
        light: 'fail',
      });
    }
  });

  it('does not borrow a pass for tuning, motion, or an unknown code', () => {
    for (const code of [VALIDATION.cameraTuning, VALIDATION.frameRateTooLow, VALIDATION.excessiveMotion, 999]) {
      assert.deepEqual(framingFromValidation(code), UNKNOWN_FRAMING);
    }
  });

  it('gives every state a text label, never colour alone', () => {
    assert.equal(framingStatusText('pass'), 'OK');
    assert.equal(framingStatusText('fail'), 'Fix');
    assert.equal(framingStatusText('unknown'), 'Waiting');
  });
});
