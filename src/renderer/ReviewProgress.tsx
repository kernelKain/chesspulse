// What: the build progress and Cancel control for Review.
// Why: scoring can take minutes and must never be an unresponsive screen.
// Removed: the player could not tell whether the build was moving or how to stop it.
import { COPY } from './copy';

export function ReviewProgress({
  progress,
  cancelling,
  onCancel,
}: {
  progress: { scored: number; total: number } | null;
  cancelling: boolean;
  onCancel(): void;
}) {
  const total = progress?.total ?? 0;
  const scored = progress?.scored ?? 0;
  return (
    <>
      <p aria-live="polite">
        {total > 0 ? COPY.review.scored(scored, total) : COPY.review.scoring}
      </p>
      {total > 0 ? (
        <progress
          className="report-progress"
          aria-label={COPY.review.positionsScored}
          value={scored}
          max={total}
        />
      ) : null}
      <button type="button" onClick={onCancel} disabled={cancelling} className="btn btn-secondary">
        {cancelling ? COPY.review.cancelling : COPY.review.cancelReport}
      </button>
    </>
  );
}
