// What: the Review refusal summary: the real reason, the coverage numbers when present, and the
// remedy the report builder supplied.
// Why: a refused review must not hide behind a generic "withheld" line.
// Removed: the player would see no reason and no next action.
import type { Refusal } from '../shared/contracts.js';
import { refusalHeading } from '../shared/timeline.js';
import { COPY } from './copy';

export function RefusalPanel({ refusal }: { refusal: Refusal }) {
  const metrics =
    refusal.measured !== undefined && refusal.threshold !== undefined
      ? COPY.refusal.metrics(refusal.measured, refusal.threshold)
      : null;

  return (
    <div className="refusal-panel inline-alert" role="alert">
      <h2>{refusalHeading(refusal.reason)}</h2>
      {metrics ? <p className="refusal-metric">{metrics}</p> : null}
      <p>{refusal.remedy}</p>
    </div>
  );
}
