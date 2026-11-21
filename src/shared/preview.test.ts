import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { previewFrameSchema } from './contracts.js';
import { DARK_LIGHT, DIM_LIGHT, downscaleRgbToRgba, lightNote, previewBoost } from './preview.js';

describe('previewBoost', () => {
  it('leaves a well-lit preview alone', () => {
    assert.equal(previewBoost(DIM_LIGHT), 1);
    assert.equal(previewBoost(0.6), 1);
    assert.equal(previewBoost(null), 1);
  });

  it('lifts a dim preview towards the dim threshold', () => {
    assert.ok(previewBoost(0.14) > 1.5);
    assert.ok(previewBoost(0.14) < 3.2);
  });

  it('caps the boost so noise does not become the picture', () => {
    assert.equal(previewBoost(0.01), 3.2);
    assert.equal(previewBoost(0), 3.2);
  });
});

describe('lightNote', () => {
  it('names a dark room and explains the brightened preview', () => {
    const note = lightNote(DARK_LIGHT - 0.01);
    assert.match(note, /too dark/);
    assert.match(note, /brightened/);
  });

  it('calls a dim room dim without alarming', () => {
    const note = lightNote((DARK_LIGHT + DIM_LIGHT) / 2);
    assert.match(note, /dim/);
  });

  it('reports a usable light level and that nothing is recorded', () => {
    const note = lightNote(0.5);
    assert.match(note, /50%/);
    assert.match(note, /Nothing is recorded/);
  });
});

describe('downscaleRgbToRgba', () => {
  function solidFrame(red: number, green: number, blue: number, width = 4, height = 2): Uint8Array {
    const bytes = new Uint8Array(width * height * 3);
    for (let index = 0; index < width * height; index += 1) {
      bytes[index * 3] = red;
      bytes[index * 3 + 1] = green;
      bytes[index * 3 + 2] = blue;
    }
    return bytes;
  }

  it('produces RGBA at the requested width and keeps the aspect ratio', () => {
    const frame = downscaleRgbToRgba(solidFrame(10, 20, 30, 40, 20), 40, 20, 120, 32);
    assert.equal(frame.width, 32);
    assert.equal(frame.height, 16);
    assert.equal(frame.rgba.byteLength, 32 * 16 * 4);
    assert.deepEqual([...frame.rgba.slice(0, 4)], [10, 20, 30, 255]);
  });

  it('reports brightness between 0 and 1', () => {
    const black = downscaleRgbToRgba(solidFrame(0, 0, 0), 4, 2, 12, 16);
    const white = downscaleRgbToRgba(solidFrame(255, 255, 255), 4, 2, 12, 16);
    assert.equal(black.light, 0);
    assert.ok(Math.abs(white.light - 1) < 1e-9, `expected ~1, got ${white.light}`);
  });

  it('caps the height so a large portrait frame still fits the schema', () => {
    const portrait = downscaleRgbToRgba(new Uint8Array(480 * 640 * 3), 480, 640, 480 * 3, 1920);
    assert.ok(portrait.width <= 1920);
    assert.ok(portrait.height <= 1080);
    assert.equal(previewFrameSchema.safeParse(portrait).success, true);
  });

  it('keeps a 640x480 frame inside both caps at outWidth 1920', () => {
    const frame = downscaleRgbToRgba(new Uint8Array(640 * 480 * 3), 640, 480, 640 * 3, 1920);
    assert.equal(frame.height, 1080);
    assert.equal(frame.width, 1440);
    assert.equal(previewFrameSchema.safeParse(frame).success, true);
  });

  it('refuses a frame that does not match its stated size', () => {
    assert.throws(() => downscaleRgbToRgba(new Uint8Array(10), 4, 2, 12, 16));
    assert.throws(() => downscaleRgbToRgba(new Uint8Array(24), 4, 2, 6, 16));
    assert.throws(() => downscaleRgbToRgba(new Uint8Array(24), 0, 2, 12, 16));
  });
});
