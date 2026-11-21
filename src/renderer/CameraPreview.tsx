// What: the camera preview, fed by the frames the main process already measures.
// Why: the player must see their own framing, and the page must not open a second camera stream.
// Removed: the player would be aiming blind, and a second stream would fight the SDK for the device.
import { useEffect, useRef, useState } from 'react';
import type { PreviewFrame } from '../shared/contracts';
import { lightNote, previewBoost } from '../shared/preview';

/** How long without a frame before the preview admits it is waiting. */
const STALE_MS = 2_000;
const LIGHT_UPDATE_MS = 500;

export function CameraPreview({ sensing }: { sensing: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastFrameAt = useRef(0);
  const lastLightAt = useRef(0);
  const [light, setLight] = useState<number | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [stale, setStale] = useState(false);
  const bridge = window.chesspulse;

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
      }
    });
  }, [bridge]);

  useEffect(() => {
    if (!sensing) {
      setStale(false);
      return undefined;
    }
    const timer = window.setInterval(() => {
      setStale(Date.now() - lastFrameAt.current > STALE_MS);
    }, 500);
    return () => window.clearInterval(timer);
  }, [sensing]);

  const boost = previewBoost(light);

  return (
    <figure className="camera">
      <canvas
        ref={canvasRef}
        className="camera-video"
        width={320}
        height={180}
        style={boost > 1 ? { filter: `brightness(${boost.toFixed(2)}) contrast(1.15)` } : undefined}
        role="img"
        aria-label="Camera preview. Nothing is recorded."
      />
      <figcaption className="hint">
        {!sensing
          ? 'The camera opens when you start sensing.'
          : !hasFrame || stale
            ? 'Waiting for the camera…'
            : lightNote(light)}
      </figcaption>
    </figure>
  );
}
