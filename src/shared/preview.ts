// What: turns a measured light level into a preview boost and a plain-language note.
// Why: the preview must stay usable for framing in dim rooms, and a dark room must be named rather than hidden.
// Removed: a dark feed would look broken, and the player would never learn the measurement needs light.
import type { PreviewFrame } from './contracts.js';

export const DARK_LIGHT = 0.18;
export const DIM_LIGHT = 0.28;
const MAX_BOOST = 3.2;

/** Luma is 0–1. Below the dim threshold the preview is lifted, never the frames the SDK measures. */
export function previewBoost(light: number | null): number {
  if (light === null || !Number.isFinite(light)) return 1;
  if (light >= DIM_LIGHT) return 1;
  if (light <= 0) return MAX_BOOST;
  return Math.min(MAX_BOOST, DIM_LIGHT / light);
}

export function lightNote(light: number | null): string {
  if (light === null || !Number.isFinite(light)) return 'Camera preview. Nothing is recorded.';
  const pct = Math.round(Math.max(0, Math.min(1, light)) * 100);
  if (light < DARK_LIGHT) {
    return `Light ${pct}% — too dark. Add a lamp in front of you; the preview is brightened so you can frame.`;
  }
  if (light < DIM_LIGHT) {
    return `Light ${pct}% — dim. A lamp in front of you will help the measurement.`;
  }
  return `Light ${pct}%. Camera preview. Nothing is recorded.`;
}

const MIN_PREVIEW_WIDTH = 16;
const MAX_PREVIEW_WIDTH = 1920;
/** The preview schema caps height too; a portrait frame must not exceed it. */
const MAX_PREVIEW_HEIGHT = 1080;

/**
 * Shrinks a packed RGB frame to RGBA for a preview, and reports its brightness.
 * One sample per output pixel: the preview only has to show framing, not detail.
 */
export function downscaleRgbToRgba(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  strideBytes: number,
  outWidth: number,
): PreviewFrame {
  if (
    !Number.isInteger(sourceWidth) ||
    !Number.isInteger(sourceHeight) ||
    sourceWidth < 2 ||
    sourceHeight < 2
  ) {
    throw new Error('The camera frame had no size.');
  }
  if (!Number.isInteger(strideBytes) || strideBytes < sourceWidth * 3) {
    throw new Error('The camera frame stride is too small for its width.');
  }
  if (source.byteLength < strideBytes * sourceHeight) {
    throw new Error('The camera frame is shorter than its size says.');
  }
  // One scale, constrained by both caps, so the aspect ratio holds and the schema never rejects it.
  const requested = Math.max(MIN_PREVIEW_WIDTH, Math.min(MAX_PREVIEW_WIDTH, Math.round(outWidth)));
  const scale = Math.min(requested / sourceWidth, MAX_PREVIEW_HEIGHT / sourceHeight);
  const width = Math.max(MIN_PREVIEW_WIDTH, Math.round(sourceWidth * scale));
  const height = Math.max(2, Math.round(sourceHeight * scale));
  const rgba = new Uint8Array(width * height * 4);
  const xs = new Int32Array(width);
  for (let x = 0; x < width; x += 1) {
    xs[x] = Math.min(sourceWidth - 1, Math.floor(((x + 0.5) * sourceWidth) / width));
  }
  let lumaSum = 0;
  let out = 0;
  for (let y = 0; y < height; y += 1) {
    const sourceRow = Math.min(sourceHeight - 1, Math.floor(((y + 0.5) * sourceHeight) / height)) * strideBytes;
    for (let x = 0; x < width; x += 1) {
      const at = sourceRow + xs[x] * 3;
      const red = source[at];
      const green = source[at + 1];
      const blue = source[at + 2];
      rgba[out] = red;
      rgba[out + 1] = green;
      rgba[out + 2] = blue;
      rgba[out + 3] = 255;
      lumaSum += (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
      out += 4;
    }
  }
  return { width, height, rgba, light: lumaSum / (width * height) };
}
