// What: the Review header — eyebrow, one headline, labelled session facts, and the computed verdict.
// Why: the old header was a raw metadata line over one long sentence. A reader now sees the result,
//      then each number with its name, then the exact verdict the report computed.
// Removed: the Review would open on "Baseline 81.4 bpm · Elevated ≥ 91.4 bpm · Coverage 88%" and a paragraph.
import { useId, useState } from 'react';
import type { Report } from '../shared/contracts';
import { buildReportSummary, type HeadlineKind } from '../shared/summary';
import { engineCalibrationNote, engineFailureNote } from '../shared/timeline';
import { COPY } from './copy';

export function ReportSummary({ report }: { report: Report }) {
  const view = buildReportSummary(report);
  const [showAll, setShowAll] = useState(false);
  const [explain, setExplain] = useState(false);
  const railId = useId();
  const helpId = useId();
  const engineNote = engineFailureNote(report.engine);

  return (
    <section className="report-summary" aria-label={COPY.summary.label}>
      <p className="report-eyebrow">{COPY.summary.eyebrow}</p>
      <p className="report-context">{COPY.summary.context(view.games, view.durationLabel)}</p>
      <h1 className="report-headline">{headlineText(view.headline, view.personal)}</h1>

      <dl
        id={railId}
        className="metric-rail"
        data-expanded={showAll ? 'true' : 'false'}
        aria-label={COPY.summary.metricsLabel}
        // The grid needs the count: one row in a wide window, two balanced rows in a medium one.
        data-count={view.metrics.length}
      >
        {view.metrics.map((metric) => (
          <div key={metric.key} className="metric" data-key={metric.key} data-primary={metric.primary ? 'true' : 'false'}>
            <dt>{COPY.summary.metrics[metric.key].label}</dt>
            <dd>{metric.value}</dd>
          </div>
        ))}
      </dl>

      <div className="summary-actions">
        {/* Shown only in a narrow window, where secondary facts start hidden. */}
        <button
          type="button"
          className="btn btn-quiet btn-small summary-more"
          aria-controls={railId}
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? COPY.summary.fewerFacts : COPY.summary.moreFacts}
        </button>
        <button
          type="button"
          className="btn btn-quiet btn-small"
          aria-controls={helpId}
          aria-expanded={explain}
          onClick={() => setExplain((value) => !value)}
        >
          {explain ? COPY.summary.hideExplain : COPY.summary.explain}
        </button>
      </div>

      {explain ? (
        <dl id={helpId} className="metric-help">
          {view.metrics.map((metric) => (
            <div key={metric.key}>
              <dt>{COPY.summary.metrics[metric.key].label}</dt>
              <dd>{COPY.summary.metrics[metric.key].help}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="report-verdict" role="group" aria-label={COPY.summary.verdictLabel}>
        {view.verdictLines.map((line, index) => (
          <p key={index}>{line}</p>
        ))}
      </div>

      <div className="report-notes">
        <p>{scopeNote(report)}</p>
        {report.occludedSec !== undefined ? <p>{COPY.verdict.occluded(report.occludedSec)}</p> : null}
        <p>{engineCalibrationNote(report.engine)}</p>
        {engineNote ? <p className="note-warn">{engineNote}</p> : null}
      </div>
    </section>
  );
}

export function headlineText(kind: HeadlineKind, personal: boolean): string {
  const lines = COPY.summary.headlines;
  switch (kind) {
    case 'no_scored':
    case 'thin_bands':
    case 'no_blunders':
      return lines[kind];
    case 'most_elevated':
    case 'some_elevated':
    case 'none_elevated':
      return lines[kind](personal);
  }
}

/** Says whose moves the accuracy covers. A report from before player scope scored both sides. */
export function scopeNote(report: Pick<Report, 'playerScope'>): string {
  const scope = report.playerScope;
  if (!scope) return COPY.verdict.scope.legacy;
  if (scope.kind === 'player') return COPY.verdict.scope.player(scope.name);
  return scope.reason === 'ambiguous' ? COPY.verdict.scope.ambiguous : COPY.verdict.scope.noCommonName;
}
