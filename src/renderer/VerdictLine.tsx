// What: renders the locally computed verdict sentence and baseline/coverage header.
// Why: §7.3 places the verdict first as the only element where the page raises its voice.
// Removed: a player would have to read charts first instead of seeing the session verdict in three seconds.
import type { Report } from '../shared/contracts';
import { engineCalibrationNote, engineFailureNote } from '../shared/timeline';
import { COPY } from './copy';

export function VerdictLine({ report }: { report: Report }) {
  const baseline = formatNumber(report.baselineBpm);
  const coverage = Math.round(report.coveragePct);
  const threshold = formatNumber(report.timeline.elevatedThresholdBpm);
  const engineNote = engineFailureNote(report.engine);

  return (
    <section className="verdict-section" aria-label={COPY.verdict.label}>
      <p className="verdict-meta">{COPY.verdict.meta(baseline, threshold, coverage)}</p>
      <h1 className="verdict-line">{report.verdict}</h1>
      {report.occludedSec !== undefined ? (
        <p className="verdict-note verdict-occluded">{COPY.verdict.occluded(report.occludedSec)}</p>
      ) : null}
      <p className="verdict-note verdict-engine">{engineCalibrationNote(report.engine)}</p>
      {engineNote ? <p className="verdict-note">{engineNote}</p> : null}
    </section>
  );
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
