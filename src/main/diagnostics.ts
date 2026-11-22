// What: one plain-text support summary the player can copy without sharing a session.
// Why: a failure needs context, but a PGN, a pulse sample, or a key must never leave the app in it.
// Removed: support would ask for a session folder or a screenshot instead of a safe text bundle.

export const DIAGNOSTICS_LOG_LINES = 100;

/** Defence in depth: a log line must never carry a PGN header or a pulse sample into a bundle. */
const SENSITIVE_LINE_PATTERNS: readonly RegExp[] = [
  /\[\s*(?:Event|Site|Date|Round|White|Black|Result|UTCDate|UTCTime|ECO|Opening|Termination|TimeControl|EndTime|FEN|SetUp|Variant)\s+"/i,
  /"(?:tUs|bpm|confidence|stable)"\s*:/,
];

export interface DiagnosticsInput {
  appVersion: string;
  electron: string;
  node: string;
  platform: string;
  arch: string;
  doctor: readonly string[];
  logLines: readonly string[];
  now?: Date;
}

/** Builds only from metadata and already-redacted log lines; it never reads a session. */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const generated = (input.now ?? new Date()).toISOString();
  const doctor = input.doctor.length > 0 ? input.doctor : ['Not run.'];
  const recent = input.logLines.slice(-DIAGNOSTICS_LOG_LINES);
  return [
    'ChessPulse diagnostics',
    `Generated: ${generated}`,
    `App version: ${oneLine(input.appVersion)}`,
    `Electron: ${oneLine(input.electron)}`,
    `Node: ${oneLine(input.node)}`,
    `Platform: ${oneLine(input.platform)} ${oneLine(input.arch)}`,
    '',
    'Doctor',
    ...doctor.map((line) => `  ${safeLine(oneLine(line))}`),
    '',
    `Recent log (last ${DIAGNOSTICS_LOG_LINES} lines)`,
    ...(recent.length > 0
      ? recent.map((line) => `  ${safeLine(oneLine(line))}`)
      : ['  No log lines yet.']),
    '',
  ].join('\n');
}

function safeLine(line: string): string {
  return SENSITIVE_LINE_PATTERNS.some((pattern) => pattern.test(line)) ? '[redacted line]' : line;
}

function oneLine(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}
