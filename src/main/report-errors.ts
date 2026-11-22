// What: turns a stored-report failure into the one code the page shows.
// Why: "missing", "older", and "newer" need different remedies, and both AI and export hit them.
// Removed: an old report would look like a generic build failure with no way forward.
import { AppError, toAppError } from '../shared/errors.js';
import { StoredReportError } from './store.js';

export function reportAppError(error: unknown): AppError {
  if (error instanceof StoredReportError) {
    const code =
      error.kind === 'missing'
        ? 'report_missing'
        : error.kind === 'newer'
          ? 'report_newer'
          : error.kind === 'stale'
            ? 'report_stale'
            : 'report_failed';
    return new AppError(code, { cause: error });
  }
  return toAppError(error, 'report_failed');
}
