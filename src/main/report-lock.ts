// What: one in-process exclusion for report builds and paired report/PGN reads.
// Why: an AI reading must use artifacts from one completed build, never two different revisions.
// Removed: a rebuild between readReport and readGames could mix old stats with new PGNs.
let queue: Promise<void> = Promise.resolve();

export function withReportExclusion<T>(operation: () => Promise<T>): Promise<T> {
  const run = queue.then(operation);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
