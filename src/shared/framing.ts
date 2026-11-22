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
 * What: the codes that mean the face could not be measured — a hand, an object, or heavy motion.
 * Why: R6-07 marks those samples instead of counting them, so coverage and the baseline never use
 *      a reading taken through a hand.
 * Removed: an occluded stretch would count as measured time, and a missing pulse would look like a
 *      calm one.
 */
const OCCLUSION_CODES = new Set<number>([
  VALIDATION.noFaceFound,
  VALIDATION.multipleFacesFound,
  VALIDATION.faceNotCentered,
  VALIDATION.faceSizeOutOfRange,
  VALIDATION.excessiveMotion,
  VALIDATION.faceTooClose,
  VALIDATION.faceTooFar,
  VALIDATION.faceTooHigh,
  VALIDATION.faceTooLow,
  VALIDATION.faceNotForward,
]);

export function isOcclusionCode(code: number): boolean {
  return OCCLUSION_CODES.has(code);
}

/**
 * What: the framing causes a refused report may name, in the order ties are broken.
 * Why: R6-08 asks a refusal to name what most often went wrong, and a tie must not depend on
 *      object key order or on which message arrived last.
 * Removed: a refusal would stay generic, and the player would not know what to change.
 */
export const FRAMING_CAUSES = [
  'no_face',
  'too_dark',
  'too_far',
  'too_close',
  'motion',
  'chest',
  'too_bright',
] as const;

export type FramingCause = (typeof FRAMING_CAUSES)[number];

/** Which cause a code belongs to. Codes about the camera itself are not the player's doing. */
export function framingCause(code: number): FramingCause | null {
  switch (code) {
    case VALIDATION.noFaceFound:
    case VALIDATION.multipleFacesFound:
    case VALIDATION.faceNotCentered:
    case VALIDATION.faceNotForward:
    case VALIDATION.faceTooHigh:
    case VALIDATION.faceTooLow:
      return 'no_face';
    case VALIDATION.tooDark:
      return 'too_dark';
    case VALIDATION.faceTooFar:
    case VALIDATION.faceSizeOutOfRange:
      return 'too_far';
    case VALIDATION.faceTooClose:
      return 'too_close';
    case VALIDATION.excessiveMotion:
      return 'motion';
    case VALIDATION.chestNotVisible:
      return 'chest';
    case VALIDATION.tooBright:
      return 'too_bright';
    default:
      return null;
  }
}

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
