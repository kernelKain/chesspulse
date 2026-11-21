// What: console writes that cannot take the process down.
// Why: a launcher whose stdout has closed makes `console.log` throw EPIPE, which surfaces as a
//      main-process crash dialog during a measurement.
// Removed: closing the terminal or a log pipe would kill a running session.
type Writer = (...args: readonly unknown[]) => void;

let out: Writer = console.log.bind(console);
let err: Writer = console.error.bind(console);

/** Replaces the console writers so a broken pipe is a dropped line, not a crash. */
export function installSafeConsole(target: Console = console): void {
  out = target.log.bind(target);
  err = target.error.bind(target);
  target.log = (...args: readonly unknown[]): void => {
    write(out, args);
  };
  target.error = (...args: readonly unknown[]): void => {
    write(err, args);
  };
}

export function log(...args: readonly unknown[]): void {
  write(out, args);
}

export function logError(...args: readonly unknown[]): void {
  write(err, args);
}

function write(writer: Writer, args: readonly unknown[]): void {
  try {
    writer(...args);
  } catch {
    // stdout or stderr is gone. Losing a log line beats losing the session.
  }
}
