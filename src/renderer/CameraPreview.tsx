// What: the camera preview, fed by the frames the main process already measures.
// Why: the player must see their own framing, and the page must not open a second camera stream.
// Removed: the player would be aiming blind, and a second stream would fight the SDK for the device.
import { useEffect, useRef, useState } from 'react';
import type { PreviewFrame } from '../shared/contracts';
import { lightNote, previewBoost } from '../shared/preview';
import { COPY } from './copy';

/** How long without a frame before the preview admits it is waiting. */
const STALE_MS = 2_000;
const LIGHT_UPDATE_MS = 500;

export function CameraPreview({
  active,
  guide = false,
  lightText = true,
  onLight,
}: {
  active: boolean;
  guide?: boolean;
  lightText?: boolean;
  onLight?: (light: number | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastFrameAt = useRef(0);
  const lastLightAt = useRef(0);
  const [light, setLight] = useState<number | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [stale, setStale] = useState(false);
  const bridge = window.chesspulse;
  // The frame callback is registered once; a ref keeps it from resubscribing on every render.
  const lightHandler = useRef(onLight);
  const staleRef = useRef(false);
  useEffect(() => {
    lightHandler.current = onLight;
  });

  useEffect(() => {
    if (!bridge) return undefined;
    return bridge.onPreview((frame: PreviewFrame) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext('2d');
      if (!context) return;
      if (canvas.width !== frame.width) canvas.width = frame.width;
      if (canvas.height !== frame.height) canvas.height = frame.height;
      const pixels = new Uint8ClampedArray(frame.rgba.byteLength);
      pixels.set(frame.rgba);
      context.putImageData(new ImageData(pixels, frame.width, frame.height), 0, 0);
      lastFrameAt.current = Date.now();
      setHasFrame((current) => current || true);
      if (Date.now() - lastLightAt.current > LIGHT_UPDATE_MS) {
        lastLightAt.current = Date.now();
        setLight(frame.light);
        lightHandler.current?.(frame.light);
      }
    });
  }, [bridge]);

  useEffect(() => {
    if (!active) {
      staleRef.current = false;
      setStale(false);
      return undefined;
    }
    const timer = window.setInterval(() => {
      const next = Date.now() - lastFrameAt.current > STALE_MS;
      const wasStale = staleRef.current;
      staleRef.current = next;
      setStale(next);
      // A stopped camera must not leave the last brightness standing in the Setup meter.
      if (next && !wasStale) {
        setLight(null);
        lightHandler.current?.(null);
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [active]);

  const boost = previewBoost(light);
  // Setup shows the meter in its framing card, so the caption would repeat the same number.
  const caption = !active
    ? COPY.camera.closed
    : !hasFrame || stale
      ? COPY.camera.waiting
      : lightText
        ? lightNote(light)
        : null;

  return (
    <figure className="camera">
      <div className="camera-frame">
        <canvas
          ref={canvasRef}
          className="camera-video"
          width={320}
          height={180}
          style={boost > 1 ? { filter: `brightness(${boost.toFixed(2)}) contrast(1.15)` } : undefined}
          role="img"
          aria-label={COPY.camera.previewAria}
        />
        {guide ? (
          <div className="framing-guide" aria-hidden="true">
            <div className="face-outline" />
            <div className="chest-line" />
          </div>
        ) : null}
      </div>
      {caption ? (
        <figcaption className="hint" aria-live="polite" aria-atomic="true">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}
