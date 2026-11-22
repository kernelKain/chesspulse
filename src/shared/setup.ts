// What: the one gate that decides whether Setup may start a session.
// Why: consent, the key, the live preview, and all three framing checks must be named in order.
// Removed: a Start button could be disabled without telling the player which check is missing.

import { framingReady, type FramingChecks } from './framing.js';

export type KeyStatus = 'loading' | 'present' | 'missing' | 'error';
export type PreviewStatus = 'idle' | 'starting' | 'running' | 'error';

export interface SetupKeyResult {
  status: KeyStatus;
  detail: string;
}

export interface DoctorCheckLike {
  id: string;
  status: string;
  detail: string;
}

const DEFAULT_MISSING_KEY =
  'The SmartSpectra key is missing. Add SMARTSPECTRA_API_KEY to .env, then restart.';

export function keyStatusFromChecks(checks: readonly DoctorCheckLike[]): SetupKeyResult {
  const check = checks.find((candidate) => candidate.id === 'sensing-key');
  if (!check) {
    return { status: 'error', detail: 'The key check did not report a result.' };
  }
  return check.status === 'pass'
    ? { status: 'present', detail: check.detail }
    : { status: 'missing', detail: check.detail || DEFAULT_MISSING_KEY };
}

export interface SetupGateInput {
  consent: boolean;
  keyStatus: KeyStatus;
  keyDetail?: string;
  preview: PreviewStatus;
  previewError?: string | null;
  framing: FramingChecks;
}

export interface SetupGate {
  canStart: boolean;
  reasons: string[];
}

/**
 * One blocking reason at a time, in the order the player fixes them. A later check is not shown
 * as the problem while an earlier one is still missing.
 */
export function setupGate(input: SetupGateInput): SetupGate {
  if (!input.consent) {
    return { canStart: false, reasons: ['Allow the camera to continue.'] };
  }
  if (input.keyStatus === 'loading') {
    return { canStart: false, reasons: ['Checking the SmartSpectra key…'] };
  }
  if (input.keyStatus === 'missing') {
    return { canStart: false, reasons: [input.keyDetail || DEFAULT_MISSING_KEY] };
  }
  if (input.keyStatus === 'error') {
    return {
      canStart: false,
      reasons: ['The key check could not run. Open Help and copy diagnostics.'],
    };
  }
  if (input.preview === 'idle' || input.preview === 'starting') {
    return { canStart: false, reasons: ['Starting the camera preview…'] };
  }
  if (input.preview === 'error') {
    return {
      canStart: false,
      reasons: [
        input.previewError ||
          'The camera preview could not start. Check that another app is not using the camera, then try again.',
      ],
    };
  }
  if (!framingReady(input.framing)) {
    return { canStart: false, reasons: ['Framing must pass all three checks.'] };
  }
  return { canStart: true, reasons: [] };
}
