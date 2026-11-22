// What: reads the stored session library for Home and the Sessions screen.
// Why: one corrupt session must not hide every healthy one, and opening must keep games reachable
//      even when a report is stale, newer, or invalid.
// Removed: earlier sessions and their PGNs could not be reached after a restart.
import {
  type Report,
  type SessionOpenResult,
  type SessionReportError,
  type SessionSummary,
} from '../shared/contracts.js';
import {
  StoredReportError,
  hasSavedReport,
  listSessions,
  readGames,
  readMeta,
  readReport,
} from './store.js';

export interface SessionLibraryResult {
  sessions: SessionSummary[];
  unreadable: number;
}

export async function listSessionSummaries(root: string): Promise<SessionLibraryResult> {
  const ids = await listSessions(root);
  const sessions: SessionSummary[] = [];
  let unreadable = 0;
  for (const id of ids) {
    try {
      const meta = await readMeta(root, id);
      const durationMs = meta.stopAnchor
        ? Math.max(0, meta.stopAnchor.monoUs - meta.startAnchor.monoUs) / 1_000
        : null;
      sessions.push({
        id,
        startedAtEpochMs: meta.startedAtEpochMs,
        durationMs,
        coveragePct: meta.coverage?.pct ?? null,
        hasReport: await hasSavedReport(root, id),
      });
    } catch {
      // One unreadable folder is counted, not allowed to break the list.
      unreadable += 1;
    }
  }
  sessions.sort((left, right) => right.startedAtEpochMs - left.startedAtEpochMs);
  return { sessions, unreadable };
}

function reportErrorKind(error: unknown): SessionReportError | null {
  if (!(error instanceof StoredReportError)) return null;
  if (error.kind === 'missing') return null;
  return error.kind;
}

export async function openStoredSession(root: string, sessionId: string): Promise<SessionOpenResult> {
  await readMeta(root, sessionId);
  let report: Report | null = null;
  let reportError: SessionReportError | null = null;
  try {
    report = await readReport(root, sessionId);
  } catch (error) {
    reportError = reportErrorKind(error);
    if (!reportError && !(error instanceof StoredReportError)) throw error;
  }
  let games: string[] = [];
  try {
    games = await readGames(root, sessionId);
  } catch {
    // A missing or invalid PGN batch leaves Games empty and the player can paste again.
    games = [];
  }
  return { report, reportError, games };
}
