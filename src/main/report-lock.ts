// What: one in-process exclusion for report builds and paired report/PGN reads.
// Why: an AI reading must use artifacts from one completed build, never two different revisions.
// Removed: a rebuild between readReport and readGames could mix old stats with new PGNs.
let queue: Promise<void> = Promise.resolve();

export function withReportExclusion<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(cancelled());
  const run = queue.then(() => {
    // A cancelled waiter must not perform the queued file reads when its turn arrives.
    if (signal?.aborted) throw cancelled();
    return operation();
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  if (!signal) return run;

  let onAbort: () => void = () => undefined;
  let rejectOnAbort: (error: Error) => void = () => undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  onAbort = () => rejectOnAbort(cancelled());
  signal.addEventListener('abort', onAbort, { once: true });
  return Promise.race([run, interrupted]).finally(() => signal.removeEventListener('abort', onAbort));
}

function cancelled(): Error {
  const error = new Error('The report wait was cancelled.');
  error.name = 'AbortError';
  return error;
}
