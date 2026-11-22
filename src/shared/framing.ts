// What: the three framing checks Setup shows, derived from the SDK's one active validation code.
// Why: Setup must name what to fix before a session, using the same hints the sensing screen gets.
// Removed: framing advice would exist only in the README, and Start could open a session that measures nothing.

/** The SDK's integer validation codes. Values are stable across SDK versions. */
export const VALIDATION = {
  ok: 0,
  noFaceFound: 1,
  multipleFacesFound: 2,
  faceNotCentered: 3,
  faceSizeOutOfRange: 4,
  tooDark: 5,
  tooBright: 6,
  chestNotVisible: 7,
  cameraTuning: 10,
  frameRateTooLow: 11,
  excessiveMotion: 12,
  faceTooClose: 13,
  faceTooFar: 14,
  faceTooHigh: 15,
  faceTooLow: 16,
  faceNotForward: 17,
} as const;

export type FramingState = 'unknown' | 'pass' | 'fail';

export interface FramingChecks {
  face: FramingState;
  chest: FramingState;
  light: FramingState;
}

export const UNKNOWN_FRAMING: FramingChecks = {
  face: 'unknown',
  chest: 'unknown',
  light: 'unknown',
};

const FACE_CODES = new Set<number>([
  VALIDATION.noFaceFound,
  VALIDATION.multipleFacesFound,
  VALIDATION.faceNotCentered,
  VALIDATION.faceSizeOutOfRange,
  VALIDATION.faceTooClose,
  VALIDATION.faceTooFar,
  VALIDATION.faceTooHigh,
  VALIDATION.faceTooLow,
  VALIDATION.faceNotForward,
]);

const LIGHT_CODES = new Set<number>([VALIDATION.tooDark, VALIDATION.tooBright]);

/**
 * The SDK reports one current code, not three independent booleans. A code that fixes one check
 * leaves the others unknown rather than borrowing an old pass from a different frame.
 */
export function framingFromValidation(code: number): FramingChecks {
  if (code === VALIDATION.ok) {
    return { face: 'pass', chest: 'pass', light: 'pass' };
  }
  if (code === VALIDATION.chestNotVisible) {
    return { face: 'pass', chest: 'fail', light: 'unknown' };
  }
  if (FACE_CODES.has(code)) {
    return { face: 'fail', chest: 'unknown', light: 'unknown' };
  }
  if (LIGHT_CODES.has(code)) {
    return { face: 'unknown', chest: 'unknown', light: 'fail' };
  }
  return UNKNOWN_FRAMING;
}

export function framingReady(checks: FramingChecks): boolean {
  return checks.face === 'pass' && checks.chest === 'pass' && checks.light === 'pass';
}

/** A text status per check, so the result never depends on colour alone. */
export function framingStatusText(state: FramingState): string {
  if (state === 'pass') return 'OK';
  if (state === 'fail') return 'Fix';
  return 'Waiting';
}
