// What: turns a stored report into a shareable JSON file with no pulse trace.
// Why: a report can be discussed without handing over the player's measured session.
// Removed: exporting would either mean nothing to share or would copy the raw samples.
import { writeFile } from 'node:fs/promises';
import {
  reportExportSchema,
  type Report,
  type ReportExport,
  type ReportExportResult,
  type TimelineData,
} from '../shared/contracts.js';

export const EXPORT_NOTE = 'This file contains no pulse samples.' as const;

export function buildReportExport(report: Report, exportedAt: Date = new Date()): ReportExport {
  return reportExportSchema.parse({
    format: 'chesspulse-report-export',
    exportedAt: exportedAt.toISOString(),
    note: EXPORT_NOTE,
    report: {
      ...report,
      timeline: withoutSamples(report.timeline),
    },
  });
}

export async function writeReportExport(
  report: Report,
  destination: string,
  exportedAt: Date = new Date(),
): Promise<void> {
  const body = `${JSON.stringify(buildReportExport(report, exportedAt), null, 2)}\n`;
  await writeFile(destination, body, { mode: 0o600 });
}

function withoutSamples(timeline: TimelineData): Omit<TimelineData, 'samples'> {
  return {
    startUs: timeline.startUs,
    stopUs: timeline.stopUs,
    baselineBpm: timeline.baselineBpm,
    elevatedThresholdBpm: timeline.elevatedThresholdBpm,
    games: timeline.games,
    moves: timeline.moves,
  };
}

export function exportResult(path: string | undefined): ReportExportResult {
  return path ? { exported: true, path } : { exported: false };
}
