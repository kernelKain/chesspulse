// What: a fixed, non-modal camera indicator that follows the page while the camera is open.
// Why: leaving Sensing for Help must not hide that the camera is still measuring.
// Removed: a live session could be running with no visible recording state.
import { COPY } from './copy';

export function CameraOpenIndicator({
  sensing,
  preview,
}: {
  sensing: boolean;
  preview: boolean;
}) {
  if (!sensing && !preview) return null;
  return (
    <p className="camera-status" role="status">
      <span className="recording-dot" aria-hidden="true" />
      {sensing ? COPY.camera.sensing : COPY.camera.preview}
    </p>
  );
}
